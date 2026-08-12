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

/** Stack and service names become argv entries; keep them to what swarm itself accepts. */
const SWARM_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

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

/**
 * Read the rollout state of one service.
 *
 * The only correct read when the stack is shared: `stackRollout` fails or blocks
 * on any sibling service's update, which has nothing to do with this deploy.
 */
export function serviceRollout(
  service: string,
  run: DockerRunner = defaultRunner,
): SwarmStackRollout {
  if (!SWARM_NAME.test(service)) {
    return { state: 'unknown', services: [], error: `invalid service name: ${service}` };
  }
  const rollout = inspectService(service, run);
  return { state: rollout.state, services: [rollout] };
}

/** Read the rollout state of every service in a stack. Never throws. */
export function stackRollout(stack: string, run: DockerRunner = defaultRunner): SwarmStackRollout {
  if (!SWARM_NAME.test(stack)) {
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

/** Running vs desired task count, the way `docker service ls` reports it. */
export interface SwarmServiceReplicas {
  running: number;
  desired: number;
}

/**
 * Read a service's running/desired replica count.
 *
 * Needed alongside `serviceRollout` because a service's FIRST deploy has no
 * `UpdateStatus` at all (swarm only records one on an update), so a brand-new
 * service would look `unknown` forever. Its tasks coming up is the only "is it
 * running?" signal available then. `docker service ls` prints the count as
 * `running/desired` for both replicated (`2/3`) and global (`2/2`) services.
 */
export function serviceReplicas(
  service: string,
  run: DockerRunner = defaultRunner,
): SwarmServiceReplicas | null {
  if (!SWARM_NAME.test(service)) return null;
  const res = run([
    'service',
    'ls',
    '--filter',
    `name=${service}`,
    '--format',
    '{{.Name}} {{.Replicas}}',
  ]);
  if (res.status !== 0) return null;

  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(' ');
    if (sep === -1) continue;
    // `--filter name=` is a prefix match, so a stack with `svc` and `svc-v2`
    // both match; require the exact name before trusting the count.
    if (trimmed.slice(0, sep) !== service) continue;
    const match = /^(\d+)\/(\d+)/.exec(trimmed.slice(sep + 1).trim());
    if (!match) return null;
    return { running: Number(match[1]), desired: Number(match[2]) };
  }
  return null;
}

export interface ConvergenceResult {
  service: string;
  state: SwarmRolloutState;
  /** Swarm's raw `UpdateStatus.State`, when it reported one. */
  raw?: string;
  /** Swarm's own explanation — for a rollback, the reason. */
  message?: string;
  /** True when the wait ended on the deadline rather than a terminal state. */
  timedOut: boolean;
}

export interface ConvergenceWaitOptions {
  /** Give up after this long. Default 10 minutes (image pulls on workers). */
  timeoutMs?: number;
  /** Time between polls. Default 5 seconds. */
  intervalMs?: number;
  /** Progress sink, one line per poll. */
  onLine?: (line: string) => void;
  /** Injected clock, for tests. */
  now?: () => number;
  /** Injected delay, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_CONVERGENCE_TIMEOUT_MS = 600_000;
const DEFAULT_CONVERGENCE_INTERVAL_MS = 5_000;

/**
 * Block until a swarm rolling update converges, rolls back, or the deadline
 * passes — the wait `docker stack deploy` never does. Polls `UpdateStatus`, and
 * for a first-time create (which has none) falls back to replica health so an
 * initial deploy resolves instead of hanging as `unknown`.
 */
export async function waitForSwarmConvergence(
  service: string,
  options: ConvergenceWaitOptions = {},
  run: DockerRunner = defaultRunner,
): Promise<ConvergenceResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONVERGENCE_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_CONVERGENCE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const onLine = options.onLine ?? ((): void => {});
  const deadline = now() + timeoutMs;

  for (;;) {
    const rollout = serviceRollout(service, run).services[0] ?? {
      service,
      state: 'unknown' as SwarmRolloutState,
    };

    if (rollout.state === 'converged' || rollout.state === 'rolled-back') {
      return { ...rollout, timedOut: false };
    }

    const replicas = serviceReplicas(service, run);

    // No UpdateStatus means a first create; its tasks reaching the desired count
    // is the only "it's up" it can give. A service mid-update keeps waiting for
    // swarm's own verdict instead — replicas can read full before it converges.
    if (
      rollout.state === 'unknown' &&
      replicas &&
      replicas.desired > 0 &&
      replicas.running >= replicas.desired
    ) {
      return { service, state: 'converged', timedOut: false };
    }

    onLine(
      `  … ${service}: ${rollout.raw ?? (replicas ? `${replicas.running}/${replicas.desired} running` : rollout.state)}`,
    );

    if (now() >= deadline) {
      return { ...rollout, timedOut: true };
    }
    await sleep(intervalMs);
  }
}
