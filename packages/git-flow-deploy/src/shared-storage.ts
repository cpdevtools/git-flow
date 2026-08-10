import { mkdir, copyFile, access, cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, join, sep, dirname } from 'node:path';
import { parse } from 'yaml';
import { safeName, majorVersion } from './slot.js';
import type { DeployManifest, SharedStorageSpec } from './types.js';

/** File dropped in a migrated target dir so a migration runs exactly once. */
const MIGRATION_MARKER = '.migrated-from';
/** Bundle-relative name of the optional migration mapping file. */
const MIGRATIONS_FILE = 'storage-migrations.yml';

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
 * Stacked layout is opted into by declaring a `stack`. Without it, storage keeps
 * the legacy flat `{base}/{service}/` shape so already-deployed services are
 * unaffected.
 */
function usesStackedLayout(manifest: DeployManifest): boolean {
  return typeof manifest.stack === 'string' && manifest.stack !== '';
}

/**
 * Absolute path to a service's shared storage root.
 *
 * `safeName` is what makes this usable: it matches the `__SERVICE__` token baked
 * into deploy bundles at pack time, so a stack.yml can mount the very directory
 * this creates.
 *
 * - legacy  → `{baseDir}/{service}`
 * - stacked → `{baseDir}/{stack}/{service}` (buckets live inside it)
 */
export function sharedStorageDir(manifest: DeployManifest, baseDir: string): string {
  const service = manifest.service ?? safeName(manifest.name);
  return usesStackedLayout(manifest)
    ? join(baseDir, manifest.stack!, service)
    : join(baseDir, service);
}

/** Unversioned bucket — data that survives major upgrades. Stacked layout only. */
export function sharedBucketDir(manifest: DeployManifest, baseDir: string): string {
  return join(sharedStorageDir(manifest, baseDir), 'shared');
}

/** Per-major bucket — isolated between coexisting majors. Stacked layout only. */
export function versionedBucketDir(manifest: DeployManifest, baseDir: string): string {
  return join(sharedStorageDir(manifest, baseDir), `v${majorVersion(manifest.version)}`);
}

function normalizeBuckets(spec: SharedStorageSpec): { shared: string[]; versioned: string[] } {
  if (typeof spec === 'boolean' || spec === undefined) return { shared: [], versioned: [] };
  if (Array.isArray(spec)) return { shared: spec, versioned: [] };
  return { shared: spec.shared ?? [], versioned: spec.versioned ?? [] };
}

/**
 * Resolve a relative entry within `root`, rejecting absolute paths, `..`
 * segments, and anything that escapes `root` after resolution.
 */
function assertWithin(root: string, entry: string, label: string): string {
  if (isAbsolute(entry)) {
    throw new Error(`${label} must be a relative path: ${entry}`);
  }
  if (entry.split('/').includes('..')) {
    throw new Error(`${label} must not contain '..': ${entry}`);
  }
  const resolved = resolve(root, entry);
  if (!resolved.startsWith(resolve(root) + sep)) {
    throw new Error(`${label} escapes ${root}: ${entry}`);
  }
  return resolved;
}

/**
 * Map a service-relative `to` onto disk. Under the stacked layout a `versioned/`
 * prefix targets the per-major bucket; every other path (e.g. `shared/...`)
 * resolves under the service root as written.
 */
function resolveTarget(manifest: DeployManifest, root: string, to: string, label: string): string {
  let rel = to;
  if (usesStackedLayout(manifest) && (rel === 'versioned' || rel.startsWith('versioned/'))) {
    rel = `v${majorVersion(manifest.version)}${rel.slice('versioned'.length)}`;
  }
  return assertWithin(root, rel, label);
}

/**
 * Create shared storage directories for a service before running deployCommand.
 *
 * Legacy (no `stack`):
 * - `sharedStorage: true`   → creates `baseDir/{service}/`
 * - `sharedStorage: [...]`  → creates `baseDir/{service}/` + each named subdir
 * - `sharedStorage: []`     → creates `baseDir/{service}/` only
 *
 * Stacked (`stack` set): always creates the `shared/` and `v{major}/` buckets,
 * then the declared subdirs within each (a bare array → shared bucket).
 *
 * Path traversal protection: entries must be relative, must not contain '..', and
 * must resolve within their bucket.
 */
export async function prepareSharedStorage(
  manifest: DeployManifest,
  baseDir: string,
): Promise<void> {
  // Explicit rather than truthiness: an empty array still declares shared storage.
  if (!declaresSharedStorage(manifest)) return;

  const root = sharedStorageDir(manifest, baseDir);

  if (!usesStackedLayout(manifest)) {
    await mkdir(root, { recursive: true });
    if (Array.isArray(manifest.sharedStorage)) {
      for (const subdir of manifest.sharedStorage) {
        await mkdir(assertWithin(root, subdir, 'sharedStorage entry'), { recursive: true });
      }
    }
    return;
  }

  const sharedDir = sharedBucketDir(manifest, baseDir);
  const versionedDir = versionedBucketDir(manifest, baseDir);
  await mkdir(sharedDir, { recursive: true });
  await mkdir(versionedDir, { recursive: true });

  const { shared, versioned } = normalizeBuckets(manifest.sharedStorage!);
  for (const subdir of shared) {
    await mkdir(assertWithin(sharedDir, subdir, 'sharedStorage entry'), { recursive: true });
  }
  for (const subdir of versioned) {
    await mkdir(assertWithin(versionedDir, subdir, 'sharedStorage entry'), { recursive: true });
  }
}

/**
 * Whether a manifest asks to seed any bundle files into shared storage.
 */
export function declaresSeedStorage(manifest: DeployManifest): boolean {
  return Array.isArray(manifest.seedStorage) && manifest.seedStorage.length > 0;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy bundle files into a service's shared storage, seed-if-missing.
 *
 * For each { from, to }: `from` is resolved within `bundleDir`, `to` within the
 * service root (a `versioned/` prefix maps to `v{major}/`). An existing target is
 * left untouched, so a redeploy never clobbers a file an operator has edited in
 * place (e.g. an allowlist).
 *
 * Path traversal protection: both `from` and `to` must be relative, must not
 * contain '..', and must resolve within their respective roots.
 */
export async function prepareSeedStorage(
  manifest: DeployManifest,
  baseDir: string,
  bundleDir: string,
): Promise<void> {
  if (!declaresSeedStorage(manifest)) return;

  const root = sharedStorageDir(manifest, baseDir);

  for (const { from, to } of manifest.seedStorage!) {
    const src = assertWithin(bundleDir, from, "seedStorage 'from'");
    const dest = resolveTarget(manifest, root, to, "seedStorage 'to'");

    // Seed-if-missing: never overwrite an existing (possibly operator-edited) file.
    if (await pathExists(dest)) continue;
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
}

interface StorageMigration {
  from: string;
  to: string;
}

async function readStorageMigrations(bundleDir: string): Promise<StorageMigration[]> {
  let content: string;
  try {
    content = await readFile(join(bundleDir, MIGRATIONS_FILE), 'utf-8');
  } catch {
    return [];
  }
  const raw = parse(content) as { migrations?: unknown } | null;
  const list = raw?.migrations;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    throw new Error(`${MIGRATIONS_FILE}: 'migrations' must be an array`);
  }
  return list.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${MIGRATIONS_FILE} migrations[${i}] must be an object with 'from' and 'to'`);
    }
    const { from, to } = entry as { from?: unknown; to?: unknown };
    if (typeof from !== 'string' || from === '') {
      throw new Error(`${MIGRATIONS_FILE} migrations[${i}].from must be a non-empty string`);
    }
    if (typeof to !== 'string' || to === '') {
      throw new Error(`${MIGRATIONS_FILE} migrations[${i}].to must be a non-empty string`);
    }
    return { from, to };
  });
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e !== MIGRATION_MARKER).length === 0;
  } catch {
    return true;
  }
}

/**
 * Copy legacy data into the new layout, one-shot, from a bundle's optional
 * `storage-migrations.yml`. Because naming across historical services is
 * inconsistent, each service declares its own explicit mappings:
 *
 *   migrations:
 *     - from: /docker-nfs/.../old-service/repos-config   # may be absolute
 *       to: shared/repos-config                          # service-relative bucket path
 *
 * Copy (not move) so a still-running older major keeps reading the old path;
 * migrate-if-empty so newer data is never clobbered; a `.migrated-from` marker in
 * the target makes it idempotent and auditable. No file → no-op.
 */
export async function prepareStorageMigrations(
  manifest: DeployManifest,
  baseDir: string,
  bundleDir: string,
): Promise<void> {
  const migrations = await readStorageMigrations(bundleDir);
  if (migrations.length === 0) return;

  const root = sharedStorageDir(manifest, baseDir);

  for (const { from, to } of migrations) {
    // `from` may be an absolute legacy path (inconsistent historical naming).
    const src = resolve(from);
    const dest = resolveTarget(manifest, root, to, "storageMigrations 'to'");

    if (!(await pathExists(src))) continue; // nothing to migrate
    if (!(await isEmptyOrMissing(dest))) continue; // migrate-if-empty; never clobber

    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true });
    await writeFile(join(dest, MIGRATION_MARKER), `${src}\n${new Date().toISOString()}\n`, 'utf-8');
  }
}
