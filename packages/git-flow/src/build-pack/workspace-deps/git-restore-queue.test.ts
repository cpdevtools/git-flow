import { describe, expect, it, vi } from 'vitest';

let inFlight = 0;
let maxInFlight = 0;
const failFor = new Set<string>();

// Stand-in for zx's `$({...})\`git checkout -- ${file}\``: slow enough that
// un-queued callers would overlap, which is what loses .git/index.lock.
vi.mock('zx', () => ({
  $: () => async (_strings: TemplateStringsArray, file: string) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    if (failFor.has(file)) throw Object.assign(new Error('git failed'), { stderr: 'fatal: boom' });
  },
}));

const { restoreTrackedFile } = await import('./git-restore.js');

describe('restoreTrackedFile queue', () => {
  it('never runs two git checkouts at once', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        restoreTrackedFile(`/repo/p${i}`, `/repo/p${i}/package.json`),
      ),
    );
    expect(maxInFlight).toBe(1);
  });

  it('surfaces a failure to its caller without blocking later restores', async () => {
    failFor.add('/repo/bad/package.json');
    const bad = restoreTrackedFile('/repo/bad', '/repo/bad/package.json');
    const good = restoreTrackedFile('/repo/ok', '/repo/ok/package.json');

    await expect(bad).rejects.toThrow(/Failed to restore .*bad.*boom/);
    await expect(good).resolves.toBeUndefined();
  });
});
