import { $ } from 'zx';

const LOCK_RETRIES = 5;
const LOCK_BACKOFF_MS = 200;

/** Tail of the restore queue — every `git checkout` in this process waits on it. */
let queue: Promise<unknown> = Promise.resolve();

function stderrOf(error: unknown): string {
  return String((error as { stderr?: unknown })?.stderr ?? (error as Error)?.message ?? error);
}

/**
 * `git checkout <file>` to drop the pack-time rewrite of a project file.
 *
 * Projects are packed concurrently but share one repo, and `git checkout` takes
 * `.git/index.lock`: two at once and one dies with "Unable to create
 * index.lock", leaving a stamped file behind. So restores are queued one at a
 * time, and a lock held by some other git process is retried with backoff.
 *
 * A file git does not track is nothing to restore and is ignored; any other
 * failure is thrown — a project left un-restored must fail the pack step.
 */
export function restoreTrackedFile(cwd: string, filePath: string): Promise<void> {
  const run = async (): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await $({ cwd, quiet: true })`git checkout -- ${filePath}`;
        return;
      } catch (error) {
        const stderr = stderrOf(error);
        if (/did not match any file/.test(stderr)) return;
        if (/index\.lock/.test(stderr) && attempt < LOCK_RETRIES) {
          await new Promise((r) => setTimeout(r, LOCK_BACKOFF_MS * attempt));
          continue;
        }
        throw new Error(`Failed to restore ${filePath}: ${stderr.trim()}`);
      }
    }
  };
  const result = queue.then(run);
  queue = result.catch(() => {});
  return result;
}
