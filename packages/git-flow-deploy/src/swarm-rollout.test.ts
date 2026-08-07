import { describe, expect, it } from 'vitest';
import {
  aggregateRollout,
  rolloutStateOf,
  stackRollout,
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

const update = (state: string, message = ''): string => JSON.stringify({ State: state, Message: message });

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
      fakeDocker(['gw_api'], { gw_api: update('rollback_completed', 'update rolled back due to failure') }),
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
