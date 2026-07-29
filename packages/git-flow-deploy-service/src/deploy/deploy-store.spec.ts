import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeployStore } from './deploy-store';

let workDir: string;
let store: DeployStore;
let stdoutSpy: jest.SpyInstance;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'deploy-store-'));
  process.env['DEPLOY_WORK_DIR'] = workDir;
  // Silence the pm2-mirror stdout echo so it doesn't pollute test output.
  stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  store = new DeployStore();
});

afterEach(() => {
  stdoutSpy.mockRestore();
  delete process.env['DEPLOY_WORK_DIR'];
  rmSync(workDir, { recursive: true, force: true });
});

function logPath(id: number): string {
  return join(workDir, String(id), 'deploy.log');
}

function readLog(id: number): string[] {
  return existsSync(logPath(id)) ? readFileSync(logPath(id), 'utf-8').split('\n').slice(0, -1) : [];
}

/** Seed a persisted record on disk (as if written by a prior service instance). */
function seed(id: number, meta: Record<string, unknown>, logLines: string[]): void {
  const dir = join(workDir, String(id));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'deploy-record.json'), JSON.stringify({ releaseId: id, ...meta }));
  writeFileSync(join(dir, 'deploy.log'), logLines.map((l) => l + '\n').join(''));
}

async function waitFor(fn: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

describe('DeployStore', () => {
  it('start() creates a running record and a fresh deploy.log', () => {
    const record = store.start(1, 'owner/repo');
    expect(record.status).toBe('running');
    expect(record.log).toHaveLength(0);
    expect(store.isRunning(1)).toBe(true);
    expect(store.get(1)).toBe(record);
    expect(existsSync(logPath(1))).toBe(true);
    expect(readLog(1)).toEqual([]);
  });

  it('get() returns undefined for unknown id', () => {
    expect(store.get(999)).toBeUndefined();
  });

  it('appendLine() adds to memory, emits, and appends to deploy.log', () => {
    const record = store.start(1, 'owner/repo');
    const received: string[] = [];
    record.signal.on('line', (l: string) => received.push(l));

    store.appendLine(record, 'hello');
    store.appendLine(record, 'world');

    expect(record.log).toEqual(['hello', 'world']);
    expect(received).toEqual(['hello', 'world']);
    expect(readLog(1)).toEqual(['hello', 'world']);
  });

  it('appendLine() mirrors output to stdout for pm2 logs', () => {
    const record = store.start(1, 'owner/repo');
    store.appendLine(record, 'a deploy line');
    expect(stdoutSpy).toHaveBeenCalledWith('[deploy 1] a deploy line\n');
  });

  it('finish() with exitCode 0 sets completed and writes EXIT:0 to the log', () => {
    const record = store.start(1, 'owner/repo');
    let doneFired = false;
    record.signal.on('done', () => {
      doneFired = true;
    });

    store.finish(record, 0);

    expect(record.status).toBe('completed');
    expect(record.log).toContain('EXIT:0');
    expect(readLog(1)).toContain('EXIT:0');
    expect(record.completedAt).toBeInstanceOf(Date);
    expect(doneFired).toBe(true);
    expect(store.isRunning(1)).toBe(false);
  });

  it('finish() with exitCode 1 sets status to failed', () => {
    const record = store.start(1, 'owner/repo');
    store.finish(record, 1);
    expect(record.status).toBe('failed');
    expect(record.log).toContain('EXIT:1');
    expect(store.isRunning(1)).toBe(false);
  });

  it('setSelfUpdate() persists the flag in metadata', () => {
    const record = store.start(1, 'owner/repo');
    store.setSelfUpdate(record);
    expect(record.selfUpdate).toBe(true);
    const meta = JSON.parse(readFileSync(join(workDir, '1', 'deploy-record.json'), 'utf-8'));
    expect(meta.selfUpdate).toBe(true);
  });

  it('start() on same id overwrites a completed record', () => {
    const r1 = store.start(3, 'owner/repo');
    store.finish(r1, 0);

    const r2 = store.start(3, 'owner/repo2');
    expect(store.get(3)).toBe(r2);
    expect(r2.status).toBe('running');
    expect(store.isRunning(3)).toBe(true);
  });

  describe('boot restore', () => {
    it('reconciles a record whose log already contains a terminal EXIT', () => {
      seed(
        10,
        { repo: 'o/r', status: 'running', startedAt: new Date().toISOString(), selfUpdate: true },
        ['line one', 'line two', 'EXIT:0'],
      );

      store.onModuleInit();

      const record = store.get(10)!;
      expect(record.status).toBe('completed');
      expect(record.log).toEqual(['line one', 'line two', 'EXIT:0']);
      expect(store.isRunning(10)).toBe(false);
    });

    it('marks a non-self-update running record as failed (no false success)', () => {
      seed(11, { repo: 'o/r', status: 'running', startedAt: new Date().toISOString() }, ['some progress']);

      store.onModuleInit();

      const record = store.get(11)!;
      expect(record.status).toBe('failed');
      expect(record.log[record.log.length - 1]).toBe('EXIT:1');
      expect(record.log.some((l) => l.includes('restarted unexpectedly'))).toBe(true);
    });

    it('resumes tailing a self-update record and finalizes when EXIT is appended externally', async () => {
      seed(
        12,
        { repo: 'o/r', status: 'running', startedAt: new Date().toISOString(), selfUpdate: true },
        ['handed off; awaiting restart…'],
      );

      store.onModuleInit();

      const record = store.get(12)!;
      expect(record.status).toBe('running');

      const streamed: string[] = [];
      record.signal.on('line', (l: string) => streamed.push(l));
      let done = false;
      record.signal.on('done', () => {
        done = true;
      });

      // Simulate the detached restart supervisor appending its output + EXIT.
      writeFileSync(
        logPath(12),
        ['handed off; awaiting restart…', '▸ pm2 restart svc', '✓ Restart verified', 'EXIT:0']
          .map((l) => l + '\n')
          .join(''),
      );

      await waitFor(() => done);

      expect(record.status).toBe('completed');
      expect(streamed).toEqual(['▸ pm2 restart svc', '✓ Restart verified', 'EXIT:0']);
      expect(record.log[record.log.length - 1]).toBe('EXIT:0');
    });

    it('resume tail finalizes as failed on a non-zero external EXIT', async () => {
      seed(
        13,
        { repo: 'o/r', status: 'running', startedAt: new Date().toISOString(), selfUpdate: true },
        ['awaiting restart…'],
      );

      store.onModuleInit();
      const record = store.get(13)!;

      let done = false;
      record.signal.on('done', () => {
        done = true;
      });

      writeFileSync(
        logPath(13),
        ['awaiting restart…', '✗ Version mismatch', 'EXIT:1'].map((l) => l + '\n').join(''),
      );

      await waitFor(() => done);
      expect(record.status).toBe('failed');
    });
  });
});
