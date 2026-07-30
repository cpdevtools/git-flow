import { spawn } from 'node:child_process';
import type { DeployManifest } from './types.js';

/**
 * Execute the deployCommand from an extracted bundle.
 * Pipes stdout and stderr line by line to `onLine`.
 * Returns the process exit code (never throws — callers check the code).
 */
export function runDeploy(
  manifest: Pick<DeployManifest, 'deployCommand'>,
  workDir: string,
  onLine: (line: string) => void,
  env?: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(manifest.deployCommand, {
      cwd: workDir,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });

    let pending = '';

    const processChunk = (chunk: Buffer): void => {
      pending += chunk.toString('utf-8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        onLine(line);
      }
    };

    child.stdout?.on('data', processChunk);
    child.stderr?.on('data', processChunk);

    child.on('error', reject);

    child.on('close', (code) => {
      if (pending.length > 0) onLine(pending);
      resolve(code ?? 1);
    });
  });
}
