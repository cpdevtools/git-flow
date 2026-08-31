import { describe, expect, it } from 'vitest';
import {
  serviceJobStatus,
  waitForSwarmJobCompletion,
  type DockerResult,
  type DockerRunner,
} from './swarm-rollout.js';

/** `.ServiceStatus` JSON as `docker service inspect` emits it. */
const svcStatus = (desired: number, running: number, completed: number): string =>
  JSON.stringify({ DesiredTasks: desired, RunningTasks: running, CompletedTasks: completed });

const ok = (stdout: string): DockerResult => ({ status: 0, stdout, stderr: '' });

/**
 * A fake docker that returns one queued `.ServiceStatus` per call, holding on
 * the last entry once the queue is drained. `null` simulates a service inspect
 * failure (no status yet).
 */
function statusSequence(statuses: Array<string | null>): {
  run: DockerRunner;
  calls: () => number;
} {
  let i = 0;
  const run: DockerRunner = () => {
    const s = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    return s === null ? { status: 1, stdout: '', stderr: 'no such service' } : ok(s);
  };
  return { run, calls: () => i };
}

/** A controllable clock: `sleep` advances `now` by the requested delay. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number): Promise<void> => {
      t += ms;
    },
  };
}

describe('serviceJobStatus', () => {
  it('parses desired/running/completed from .ServiceStatus', () => {
    const { run } = statusSequence([svcStatus(3, 1, 2)]);
    expect(serviceJobStatus('batch', run)).toEqual({ desired: 3, running: 1, completed: 2 });
  });

  it('returns null when the field is absent (older docker / not a job)', () => {
    expect(serviceJobStatus('batch', () => ok('null'))).toBeNull();
  });

  it('returns null on an inspect failure', () => {
    expect(
      serviceJobStatus('batch', () => ({ status: 1, stdout: '', stderr: 'no such service' })),
    ).toBeNull();
  });

  it('rejects an invalid service name without shelling out', () => {
    let called = false;
    serviceJobStatus('bad name; rm -rf', () => {
      called = true;
      return ok('null');
    });
    expect(called).toBe(false);
  });
});

describe('waitForSwarmJobCompletion', () => {
  it('completes when running hits 0 and completed meets desired', async () => {
    const { run } = statusSequence([svcStatus(1, 1, 0), svcStatus(1, 0, 1)]);
    const result = await waitForSwarmJobCompletion('batch', { ...fakeClock() }, run);
    expect(result.state).toBe('completed');
    expect(result.timedOut).toBe(false);
    expect(result.status).toEqual({ desired: 1, running: 0, completed: 1 });
  });

  it('completes a replicated-job once all replicas finish', async () => {
    const { run } = statusSequence([svcStatus(3, 3, 0), svcStatus(3, 1, 2), svcStatus(3, 0, 3)]);
    const result = await waitForSwarmJobCompletion('migrate', { ...fakeClock() }, run);
    expect(result.state).toBe('completed');
  });

  it('fails when tasks settle unmet for the stability window', async () => {
    // active → then running 0 with completed < desired, stable for 2 polls.
    const { run } = statusSequence([svcStatus(1, 1, 0), svcStatus(1, 0, 0), svcStatus(1, 0, 0)]);
    const result = await waitForSwarmJobCompletion(
      'batch',
      { ...fakeClock(), failStabilityPolls: 2 },
      run,
    );
    expect(result.state).toBe('failed');
    expect(result.timedOut).toBe(false);
  });

  it('waits through a retry instead of failing (a live task resets the streak)', async () => {
    const { run } = statusSequence([
      svcStatus(1, 1, 0), // active
      svcStatus(1, 0, 0), // task exited non-zero, streak 1
      svcStatus(1, 1, 0), // swarm retried — streak resets
      svcStatus(1, 0, 1), // retry succeeded
    ]);
    const result = await waitForSwarmJobCompletion(
      'batch',
      { ...fakeClock(), failStabilityPolls: 2 },
      run,
    );
    expect(result.state).toBe('completed');
  });

  it('times out when tasks never complete', async () => {
    const { run } = statusSequence([svcStatus(1, 1, 0)]); // forever running
    const result = await waitForSwarmJobCompletion(
      'batch',
      { ...fakeClock(), timeoutMs: 20_000, intervalMs: 5_000 },
      run,
    );
    expect(result.state).toBe('timed-out');
    expect(result.timedOut).toBe(true);
  });

  it("does not mistake a prior iteration's completed counts for this run", async () => {
    // Leftover complete counts before the forced iteration registers, then the
    // new run starts and completes. Must NOT return on the first poll.
    const { run, calls } = statusSequence([
      svcStatus(1, 0, 1), // leftover from last deploy — within grace, hold
      svcStatus(1, 0, 1), // still not started — hold
      svcStatus(1, 1, 0), // new iteration registers
      svcStatus(1, 0, 1), // new iteration completes
    ]);
    const result = await waitForSwarmJobCompletion(
      'batch',
      { ...fakeClock(), startGraceMs: 100_000, intervalMs: 5_000 },
      run,
    );
    expect(result.state).toBe('completed');
    // It held through the leftover polls rather than returning immediately.
    expect(calls()).toBeGreaterThanOrEqual(4);
  });

  it('emits a progress line each poll so the gateway log-inactivity timer never trips', async () => {
    const { run } = statusSequence([svcStatus(1, 1, 0), svcStatus(1, 0, 1)]);
    const lines: string[] = [];
    await waitForSwarmJobCompletion('batch', { ...fakeClock(), onLine: (l) => lines.push(l) }, run);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('batch'))).toBe(true);
  });
});
