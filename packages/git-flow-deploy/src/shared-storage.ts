import { mkdir } from 'node:fs/promises';
import { isAbsolute, resolve, join, sep } from 'node:path';
import { safeName } from './slot.js';
import type { DeployManifest } from './types.js';

/**
 * Whether a manifest asks for shared storage at all.
 *
 * Not a truthiness check: `sharedStorage: []` declares shared storage with no
 * subdirs, and an empty array is truthy anyway — callers should not have to
 * know that.
 */
export function declaresSharedStorage(manifest: DeployManifest): boolean {
  return manifest.sharedStorage !== undefined && manifest.sharedStorage !== false;
}

/**
 * Absolute path to a service's shared storage directory.
 *
 * `safeName` is what makes this usable: it matches the `__SERVICE__` token baked
 * into deploy bundles at pack time, so a stack.yml can mount the very directory
 * this creates. Using the raw package name would put an `@scope/` pair of
 * directories on disk that no token can reproduce.
 */
export function sharedStorageDir(manifest: DeployManifest, baseDir: string): string {
  return join(baseDir, safeName(manifest.name));
}

/**
 * Create shared storage directories for a service before running deployCommand.
 *
 * - `sharedStorage: true`    → creates `baseDir/{service}/`
 * - `sharedStorage: [...]`   → creates `baseDir/{service}/` + each named subdir within it
 * - `sharedStorage: []`      → creates `baseDir/{service}/` only
 * - `sharedStorage` absent/false → no-op
 *
 * Path traversal protection: entries must be relative, must not contain '..', and
 * the resolved path must remain within `baseDir/{service}/`.
 */
export async function prepareSharedStorage(
  manifest: DeployManifest,
  baseDir: string,
): Promise<void> {
  // Explicit rather than truthiness: an empty array still declares shared storage.
  if (!declaresSharedStorage(manifest)) return;

  const serviceDir = sharedStorageDir(manifest, baseDir);
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
