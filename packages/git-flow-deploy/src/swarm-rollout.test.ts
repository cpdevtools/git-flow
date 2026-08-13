import { describe, expect, it } from 'vitest';
import {
  aggregateRollout,
  rolloutStateOf,
  serviceReplicas,
  serviceRollout,
  stackRollout,
  waitForSwarmConvergence,
  type DockerResult,
  type DockerRunner,
} from './swarm-rollout.js';

const ok = (stdout: string): DockerResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr: string): DockerResult => ({ status: 1, stdout: '', stderr });

/** A fake docker that lists `services` and reports each one's UpdateStatus JSON. */
function fakeDocker(
  services: string[],
  status: Record<string, string | null>,
  calls: string[][] = [],
): DockerRunner {
  return (args) => {
    calls.push(args);
    if (args[0] === 'stack') return ok(services.join('\n') + '\n');
    const name = args[2];
    const s = status[name];
    return s === undefined ? fail('no such service') : ok(s === null ? 'null' : s);
  };
}

const update = (state: string, message = ''): string =>
  JSON.stringify({ State: state, Message: message });

describe('rolloutStateOf', () => {
  it('treats a completed update as converged', () => {
    expect(rolloutStateOf('completed')).toBe('converged');
  });

  it('treats an update still in flight as in-progress', () => {
    expect(rolloutStateOf('updating')).toBe('in-progress');
    // A rollback that has started is still moving; the outcome isn't final yet.
    expect(rolloutStateOf('rollback_started')).toBe('in-progress');
  });

  it('treats every terminal rollback or pause as a failure', () => {
    expect(rolloutStateOf('rollback_completed')).toBe('rolled-back');
    expect(rolloutStateOf('rollback_paused')).toBe('rolled-back');
    // Swarm only pauses an update it could not complete.
    expect(rolloutStateOf('paused')).toBe('rolled-back');
  });

  it('does not guess at an absent or unrecognized state', () => {
    expect(rolloutStateOf(undefined)).toBe('unknown');
    expect(rolloutStateOf('something-new')).toBe('unknown');
  });
});

describe('aggregateRollout', () => {
  it('is converged only when every service is', () => {
    expect(
      aggregateRollout([
        { service: 'a', state: 'converged' },
        { service: 'b', state: 'converged' },
      ]),
    ).toBe('converged');
  });

  it('fails the stack as soon as one service rolled back, even mid-rollout', () => {
    expect(
      aggregateRollout([
        { service: 'a', state: 'rolled-back' },
        { service: 'b', state: 'in-progress' },
      ]),
    ).toBe('rolled-back');
  });

  it('keeps waiting while any service is still rolling', () => {
    expect(
      aggregateRollout([
        { service: 'a', state: 'converged' },
        { service: 'b', state: 'in-progress' },
      ]),
    ).toBe('in-progress');
  });

  it('will not report success when a service state is unknown', () => {
    expect(
      aggregateRollout([
        { service: 'a', state: 'converged' },
        { service: 'b', state: 'unknown' },
      ]),
    ).toBe('unknown');
  });

  it('has nothing to report for an empty stack', () => {
    expect(aggregateRollout([])).toBe('unknown');
  });
});

describe('stackRollout', () => {
  it('reports a converged single-service stack', () => {
    const r = stackRollout('gw', fakeDocker(['gw_api'], { gw_api: update('completed') }));
    expect(r.state).toBe('converged');
    expect(r.services).toEqual([
      { service: 'gw_api', state: 'converged', raw: 'completed', message: '' },
    ]);
  });

  it('carries swarm\u2019s own reason through on a rollback', () => {
    const r = stackRollout(
      'gw',
      fakeDocker(['gw_api'], {
        gw_api: update('rollback_completed', 'update rolled back due to failure'),
      }),
    );
    expect(r.state).toBe('rolled-back');
    expect(r.services[0].message).toBe('update rolled back due to failure');
  });

  it('asks swarm for the status rather than the exit code of the deploy', () => {
    const calls: string[][] = [];
    stackRollout('gw', fakeDocker(['gw_api'], { gw_api: update('updating') }, calls));
    expect(calls[0]).toEqual(['stack', 'services', 'gw', '--format', '{{.Name}}']);
    // json, not .State — a never-updated service has a nil UpdateStatus and the
    // field access would fail the Go template instead of returning nothing.
    expect(calls[1]).toEqual([
      'service',
      'inspect',
      'gw_api',
      '--format',
      '{{json .UpdateStatus}}',
    ]);
  });

  it('is unknown, not converged, for a service that has never been updated', () => {
    const r = stackRollout('gw', fakeDocker(['gw_api'], { gw_api: null }));
    expect(r.state).toBe('unknown');
  });

  it('is unknown when the stack does not exist', () => {
    const r = stackRollout('gw', () => fail('Nothing found in stack: gw'));
    expect(r.state).toBe('unknown');
    expect(r.error).toContain('Nothing found in stack');
  });

  it('is unknown when a service cannot be inspected', () => {
    const r = stackRollout('gw', fakeDocker(['gw_api'], {}));
    expect(r.state).toBe('unknown');
  });

  it('rejects a stack name that could be read as a flag', () => {
    const r = stackRollout('--help', () => {
      throw new Error('docker must not be invoked');
    });
    expect(r.state).toBe('unknown');
    expect(r.error).toContain('invalid stack name');
  });

  it('covers every service in a multi-service stack', () => {
    const r = stackRollout(
      'gw',
      fakeDocker(['gw_api', 'gw_worker'], {
        gw_api: update('completed'),
        gw_worker: update('updating'),
      }),
    );
    expect(r.state).toBe('in-progress');
    expect(r.services.map((s) => s.service)).toEqual(['gw_api', 'gw_worker']);
  });
});

describe('serviceRollout', () => {
  it('reads the one service and never lists the stack', () => {
    const calls: string[][] = [];
    const r = serviceRollout(
      'webservice_gw-v1',
      fakeDocker(['webservice_gw-v1'], { 'webservice_gw-v1': update('completed') }, calls),
    );
    expect(r.state).toBe('converged');
    expect(calls).toEqual([
      ['service', 'inspect', 'webservice_gw-v1', '--format', '{{json .UpdateStatus}}'],
    ]);
  });

  it('ignores a sibling service in the shared stack that rolled back', () => {
    const calls: string[][] = [];
    const r = serviceRollout(
      'webservice_gw-v1',
      fakeDocker(
        ['webservice_gw-v1', 'webservice_other'],
        {
          'webservice_gw-v1': update('completed'),
          webservice_other: update('rollback_completed'),
        },
        calls,
      ),
    );
    expect(r.state).toBe('converged');
  });

  it('rejects a service name that could be read as a flag', () => {
    const r = serviceRollout('--help', () => {
      throw new Error('docker must not be invoked');
    });
    expect(r.state).toBe('unknown');
    expect(r.error).toContain('invalid service name');
  });
});

describe('serviceReplicas', () => {
  const lsRunner =
    (line: string): DockerRunner =>
    (args) => {
      expect(args[0]).toBe('service');
      expect(args[1]).toBe('ls');
      return ok(line);
    };

  it('parses running/desired from docker service ls', () => {
    expect(serviceReplicas('webservice_gw-v1', lsRunner('webservice_gw-v1 2/3\n'))).toEqual({
      running: 2,
      desired: 3,
    });
  });

  it('matches the exact service, not a prefix sibling', () => {
    // `--filter name=` is a prefix match: gw-v1 also lists gw-v10.
    const runner = lsRunner('webservice_gw-v10 1/1\nwebservice_gw-v1 3/3\n');
    expect(serviceReplicas('webservice_gw-v1', runner)).toEqual({ running: 3, desired: 3 });
  });

  it('is null when the service is not listed', () => {
    expect(serviceReplicas('webservice_gw-v1', lsRunner('webservice_other 1/1\n'))).toBeNull();
  });

  it('is null when docker fails', () => {
    expect(serviceReplicas('webservice_gw-v1', () => fail('boom'))).toBeNull();
  });

  it('rejects a service name that could be read as a flag', () => {
    expect(
      serviceReplicas('--help', () => {
        throw new Error('docker must not be invoked');
      }),
    ).toBeNull();
  });
});

describe('waitForSwarmConvergence', () => {
  /** A fake clock the injected sleep advances, so the loop never really waits. */
  function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let t = 0;
    return { now: () => t, sleep: async (ms) => void (t += ms) };
  }

  /** Scripts UpdateStatus per inspect call (repeating the last) plus a replica line. */
  function scripted(inspects: (string | null)[], replicas?: string): DockerRunner {
    let i = 0;
    return (args) => {
      if (args[0] === 'service' && args[1] === 'inspect') {
        const s = inspects[Math.min(i++, inspects.length - 1)];
        return ok(s === null ? 'null' : s);
      }
      if (args[0] === 'service' && args[1] === 'ls') {
        if (!replicas) return ok('');
        const name = String(args[3]).slice('name='.length);
        return ok(`${name} ${replicas}\n`);
      }
      return fail('unexpected docker call');
    };
  }

  it('returns once the rolling update completes', async () => {
    const { now, sleep } = clock();
    const result = await waitForSwarmConvergence(
      'webservice_gw-v1',
      { now, sleep },
      scripted([update('updating'), update('completed')]),
    );
    expect(result).toMatchObject({ state: 'converged', timedOut: false });
  });

  it('fails as soon as swarm rolls the update back', async () => {
    const { now, sleep } = clock();
    const result = await waitForSwarmConvergence(
      'webservice_gw-v1',
      { now, sleep },
      scripted([update('rollback_completed', 'task failed health check')]),
    );
    expect(result.state).toBe('rolled-back');
    expect(result.timedOut).toBe(false);
    expect(result.message).toBe('task failed health check');
  });

  it('converges a first create off replica health when there is no UpdateStatus', async () => {
    const { now, sleep } = clock();
    const result = await waitForSwarmConvergence(
      'webservice_gw-v1',
      { now, sleep },
      scripted([null], '1/1'),
    );
    expect(result).toMatchObject({ state: 'converged', timedOut: false });
  });

  it('keeps waiting on a create until its tasks are all up', async () => {
    const { now, sleep } = clock();
    // desired not yet met → not converged on the first look.
    let listed = 0;
    const runner: DockerRunner = (args) => {
      if (args[1] === 'inspect') return ok('null');
      listed += 1;
      return ok(`webservice_gw-v1 ${listed >= 2 ? '2/2' : '1/2'}\n`);
    };
    const result = await waitForSwarmConvergence('webservice_gw-v1', { now, sleep }, runner);
    expect(result.state).toBe('converged');
  });

  it('gives up at the deadline and reports the timeout', async () => {
    const { now, sleep } = clock();
    const result = await waitForSwarmConvergence(
      'webservice_gw-v1',
      { now, sleep, timeoutMs: 12_000, intervalMs: 5_000 },
      scripted([update('updating')]),
    );
    expect(result.timedOut).toBe(true);
    expect(result.state).toBe('in-progress');
  });
});
