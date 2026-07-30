import { mkdir } from 'node:fs/promises';
import { isAbsolute, resolve, join, sep } from 'node:path';
import type { DeployManifest } from './types.js';

/**
 * Create shared storage directories for a service before running deployCommand.
 *
 * - `sharedStorage: true`    → creates `baseDir/{name}/`
 * - `sharedStorage: [...]`   → creates `baseDir/{name}/` + each named subdir within it
 * - `sharedStorage` absent/false → no-op
 *
 * Path traversal protection: entries must be relative, must not contain '..', and
 * the resolved path must remain within `baseDir/{name}/`.
 */
export async function prepareSharedStorage(
  manifest: DeployManifest,
  baseDir: string,
): Promise<void> {
  if (!manifest.sharedStorage) return;

  const serviceDir = join(baseDir, manifest.name);
  await mkdir(serviceDir, { recursive: true });

  if (!Array.isArray(manifest.sharedStorage)) return;

  const canonicalServiceDir = resolve(serviceDir) + sep;

  for (const subdir of manifest.sharedStorage) {
    if (isAbsolute(subdir)) {
      throw new Error(`sharedStorage entry must be a relative path: ${subdir}`);
    }
    if (subdir.split('/').includes('..')) {
      throw new Error(`sharedStorage entry must not contain '..': ${subdir}`);
    }
    const resolved = resolve(serviceDir, subdir);
    if (!resolved.startsWith(canonicalServiceDir)) {
      throw new Error(`sharedStorage entry escapes service directory: ${subdir}`);
    }
    await mkdir(resolved, { recursive: true });
  }
}
