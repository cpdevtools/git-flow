import { spawnSync } from 'node:child_process';

/**
 * Outcome of a swarm rolling update, as swarm itself sees it.
 *
 * This exists because `docker stack deploy` is asynchronous: it returns as soon
 * as the manager accepts the new service spec, long before any task has been
 * replaced. Its exit code therefore says nothing about whether the rollout
 * worked. Swarm tracks the real answer in the service's `UpdateStatus`, and any
 * manager can read it — including one that took over the deploy record from a
 * replica the update itself destroyed.
 */
export type SwarmRolloutState = 'converged' | 'rolled-back' | 'in-progress' | 'unknown';

export interface SwarmServiceRollout {
  service: string;
  state: SwarmRolloutState;
  /** Swarm's raw `UpdateStatus.State`, when it reported one. */
  raw?: string;
  /** Swarm's own explanation — for a rollback, the reason. */
  message?: string;
}

export interface SwarmStackRollout {
  state: SwarmRolloutState;
  services: SwarmServiceRollout[];
  /** Why the state is `unknown`, when it is. */
  error?: string;
}

export interface DockerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Injected so the mapping and aggregation can be tested without a swarm. */
export type DockerRunner = (args: string[]) => DockerResult;

/** Stack names become argv entries; keep them to what swarm itself accepts. */
const STACK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const defaultRunner: DockerRunner = (args) => {
  const res = spawnSync('docker', args, { encoding: 'utf-8' });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
};

/**
 * Map a swarm `UpdateStatus.State` onto an outcome.
 *
 * `paused` and `rollback_paused` count as failures: swarm only pauses an update
 * it could not complete, so the deploy is over and it did not work.
 */
export function rolloutStateOf(raw: string | undefined): SwarmRolloutState {
  switch (raw) {
    case 'completed':
      return 'converged';
    case 'updating':
    case 'rollback_started':
      return 'in-progress';
    case 'rollback_completed':
    case 'rollback_paused':
    case 'paused':
      return 'rolled-back';
    default:
      // Includes a service that has never been updated, which reports no status
      // at all. "Not yet decided" is the honest answer; the caller keeps waiting.
      return 'unknown';
  }
}

/**
 * Reduce per-service outcomes to one. A failure anywhere fails the whole stack,
 * even if another service is still rolling — the deploy is not going to recover.
 */
export function aggregateRollout(services: readonly SwarmServiceRollout[]): SwarmRolloutState {
  if (services.length === 0) return 'unknown';
  if (services.some((s) => s.state === 'rolled-back')) return 'rolled-back';
  if (services.some((s) => s.state === 'in-progress')) return 'in-progress';
  if (services.every((s) => s.state === 'converged')) return 'converged';
  return 'unknown';
}

/** Read the rollout state of every service in a stack. Never throws. */
export function stackRollout(stack: string, run: DockerRunner = defaultRunner): SwarmStackRollout {
  if (!STACK_NAME.test(stack)) {
    return { state: 'unknown', services: [], error: `invalid stack name: ${stack}` };
  }

  const listed = run(['stack', 'services', stack, '--format', '{{.Name}}']);
  if (listed.status !== 0) {
    return {
      state: 'unknown',
      services: [],
      error: listed.stderr.trim() || `docker stack services exited ${listed.status}`,
    };
  }

  const names = listed.stdout
    .split('\n')
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0) {
    return { state: 'unknown', services: [], error: `no services in stack ${stack}` };
  }

  const services = names.map((service) => inspectService(service, run));
  return { state: aggregateRollout(services), services };
}

function inspectService(service: string, run: DockerRunner): SwarmServiceRollout {
  // `{{json .UpdateStatus}}` prints `null` for a service that has never been
  // updated; `{{.UpdateStatus.State}}` would fail the template on a nil pointer.
  const res = run(['service', 'inspect', service, '--format', '{{json .UpdateStatus}}']);
  if (res.status !== 0) return { service, state: 'unknown' };

  let status: { State?: string; Message?: string } | null;
  try {
    status = JSON.parse(res.stdout.trim() || 'null') as typeof status;
  } catch {
    return { service, state: 'unknown' };
  }
  if (!status) return { service, state: 'unknown' };

  return {
    service,
    state: rolloutStateOf(status.State),
    raw: status.State,
    message: status.Message,
  };
}
