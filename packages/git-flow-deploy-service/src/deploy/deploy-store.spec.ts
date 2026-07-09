import { DeployStore } from './deploy-store';

describe('DeployStore', () => {
  let store: DeployStore;

  beforeEach(() => {
    store = new DeployStore();
  });

  it('start() creates a running record', () => {
    const record = store.start(1, 'owner/repo');
    expect(record.status).toBe('running');
    expect(record.log).toHaveLength(0);
    expect(store.isRunning(1)).toBe(true);
    expect(store.get(1)).toBe(record);
  });

  it('get() returns undefined for unknown id', () => {
    expect(store.get(999)).toBeUndefined();
  });

  it('appendLine() adds to log and emits line event', () => {
    const record = store.start(1, 'owner/repo');
    const received: string[] = [];
    record.signal.on('line', (l: string) => received.push(l));

    store.appendLine(record, 'hello');
    store.appendLine(record, 'world');

    expect(record.log).toEqual(['hello', 'world']);
    expect(received).toEqual(['hello', 'world']);
  });

  it('finish() with exitCode 0 sets status to completed', () => {
    const record = store.start(1, 'owner/repo');
    let doneFired = false;
    record.signal.on('done', () => { doneFired = true; });

    store.finish(record, 0);

    expect(record.status).toBe('completed');
    expect(record.log).toContain('EXIT:0');
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

  it('isRunning() returns false for completed deploy', () => {
    const record = store.start(2, 'owner/repo');
    store.finish(record, 0);
    expect(store.isRunning(2)).toBe(false);
  });

  it('start() on same id overwrites a completed record', () => {
    const r1 = store.start(3, 'owner/repo');
    store.finish(r1, 0);

    const r2 = store.start(3, 'owner/repo2');
    expect(store.get(3)).toBe(r2);
    expect(r2.status).toBe('running');
    expect(store.isRunning(3)).toBe(true);
  });
});
