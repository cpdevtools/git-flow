import {
  mkdir,
  copyFile,
  access,
  cp,
  readFile,
  readdir,
  writeFile,
  appendFile,
  rm,
  stat,
} from 'node:fs/promises';
import { isAbsolute, resolve, join, sep, dirname } from 'node:path';
import { parse } from 'yaml';
import { safeName, majorVersion } from './slot.js';
import type { DeployManifest, SharedStorageSpec } from './types.js';

/** File dropped in a migrated target dir so a mapping copies exactly once. */
const MIGRATION_MARKER = '.migrated-from';
/** Bundle-relative folder holding ordered migration files. */
const MIGRATIONS_DIR = 'storage-migrations';
/** Ledger of applied migration files, kept in the service's shared storage root. */
const MIGRATIONS_LEDGER = '.storage-migrations.yml';

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

function parseStorageMigrations(content: string, label: string): StorageMigration[] {
  const raw = parse(content) as { migrations?: unknown } | null;
  const list = raw?.migrations;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    throw new Error(`${label}: 'migrations' must be an array`);
  }
  return list.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${label} migrations[${i}] must be an object with 'from' and 'to'`);
    }
    const { from, to } = entry as { from?: unknown; to?: unknown };
    if (typeof from !== 'string' || from === '') {
      throw new Error(`${label} migrations[${i}].from must be a non-empty string`);
    }
    if (typeof to !== 'string' || to === '') {
      throw new Error(`${label} migrations[${i}].to must be a non-empty string`);
    }
    return { from, to };
  });
}

/** Migration files in the bundle's storage-migrations/ folder, in execution order. */
async function listMigrationFiles(bundleDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(join(bundleDir, MIGRATIONS_DIR));
  } catch {
    return []; // No folder → no migrations.
  }
  // Alphabetical byte order IS the execution order — name files to sort
  // (0001-..., 0002-...), like EF Core's timestamp-prefixed migrations.
  return entries.filter((e) => e.endsWith('.yml') || e.endsWith('.yaml')).sort();
}

interface AppliedMigration {
  file: string;
  at: string;
  version: string;
}

/**
 * Applied files, as a set of filenames. The ledger is append-only, so a file may
 * legitimately appear more than once (two racers can both note it before the
 * dedupe below matters) — the set semantics absorb that.
 */
async function readLedger(ledgerPath: string): Promise<Set<string>> {
  let content: string;
  try {
    content = await readFile(ledgerPath, 'utf-8');
  } catch {
    return new Set();
  }
  const raw = parse(content) as { applied?: unknown } | null;
  const list = Array.isArray(raw?.applied) ? (raw.applied as AppliedMigration[]) : [];
  return new Set(list.map((a) => a.file));
}

const LEDGER_HEADER = `# Applied storage migrations — maintained by the deploy CLI, one entry per
# migration file ever run for this service. Do not edit; to change what a
# migration did, ship a NEW file (applied files are never re-run, like EF Core).
# Append-only on purpose: appends stay visible across NFS clients where a
# rewrite-by-rename can serve another replica a stale cached inode.
applied:
`;

/**
 * Record one applied file. Append-only — the ledger is never rewritten, for the
 * same reason deploy.log is tailed rather than replaced: appends to one inode
 * are what NFS close-to-open consistency makes reliably visible to the other
 * replicas.
 */
async function appendLedgerEntry(
  ledgerPath: string,
  entry: AppliedMigration,
  isNew: boolean,
): Promise<void> {
  const line = `  - file: ${entry.file}\n    at: ${entry.at}\n    version: '${entry.version}'\n`;
  await appendFile(ledgerPath, isNew ? LEDGER_HEADER + line : line, 'utf-8');
}

/** Lock file guarding a service's migration run across replicas. */
const MIGRATIONS_LOCK = '.storage-migrations.lock';

export interface MigrationLockOptions {
  /** How long to wait for another replica's run before giving up. */
  waitMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
  /** A lock older than this is a crashed holder and may be broken. */
  staleMs?: number;
}

/**
 * Serialize migration runs per SERVICE. The deploy claim only serializes per
 * release — two releases of the same service deploying concurrently (three
 * gateway replicas make that real) would otherwise interleave on one ledger.
 * Same mechanism as deploy.claim: O_EXCL create on shared storage is the one
 * primitive every replica can see. A fresh lock is waited on (the holder is
 * running the very migrations we came to run); a stale one is broken.
 */
async function withMigrationLock(
  root: string,
  opts: MigrationLockOptions,
  run: () => Promise<void>,
): Promise<void> {
  const { waitMs = 120_000, pollMs = 2_000, staleMs = 600_000 } = opts;
  const lockPath = join(root, MIGRATIONS_LOCK);
  const deadline = Date.now() + waitMs;

  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      let age = 0;
      try {
        age = Date.now() - (await stat(lockPath)).mtimeMs;
      } catch {
        continue; // Holder released between our create and stat — retry immediately.
      }

      if (age > staleMs) {
        // Crashed holder. Remove and retry the exclusive create — if two
        // replicas break it at once, the create still admits only one.
        await rm(lockPath, { force: true });
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `storage-migrations: another replica holds ${lockPath} (age ${Math.round(age / 1000)}s); ` +
            `gave up after ${waitMs / 1000}s`,
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  try {
    await run();
  } finally {
    await rm(lockPath, { force: true });
  }
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
 * Apply the bundle's `storage-migrations/` folder — a simplified take on EF
 * Core's migration mechanism. Each `.yml` file in the folder holds explicit
 * mappings:
 *
 *   migrations:
 *     - from: /docker-nfs/.../old-service/repos-config   # may be absolute
 *       to: shared/repos-config                          # service-relative bucket path
 *
 * Files execute in alphabetical byte order (name them 0001-…, 0002-…), and a
 * ledger in the service's shared storage root (`.storage-migrations.yml`)
 * records each file that has completed — an applied file is NEVER run again,
 * even if a later release ships it with different content; ship a new file
 * instead. The ledger is written after every completed file, so a failure
 * mid-sequence re-runs only the failed file and what follows it.
 *
 * Within a file, the mapping semantics are unchanged: copy (not move) so a
 * still-running older major keeps reading the old path; migrate-if-empty so
 * newer data is never clobbered; a `.migrated-from` marker in the target for
 * audit. No folder → no-op.
 *
 * Concurrency: the gateway runs three replicas and the deploy claim is
 * per-RELEASE, so two releases of the same service can deploy at once. Runs are
 * serialized per service by an O_EXCL lock file, the ledger is re-read after
 * the lock is won (the previous holder may have applied everything), and it is
 * append-only so another replica never reads a stale rewrite.
 */
export async function prepareStorageMigrations(
  manifest: DeployManifest,
  baseDir: string,
  bundleDir: string,
  lockOpts: MigrationLockOptions = {},
): Promise<void> {
  const files = await listMigrationFiles(bundleDir);
  if (files.length === 0) return;

  const root = sharedStorageDir(manifest, baseDir);
  await mkdir(root, { recursive: true }); // lock + ledger live here

  await withMigrationLock(root, lockOpts, async () => {
    const ledgerPath = join(root, MIGRATIONS_LEDGER);
    // Read INSIDE the lock: the holder we just waited out may have applied
    // some or all of these files.
    let done = await readLedger(ledgerPath);
    let ledgerExists = done.size > 0 || (await pathExists(ledgerPath));

    for (const file of files) {
      if (done.has(file)) continue;

      const label = `${MIGRATIONS_DIR}/${file}`;
      const migrations = parseStorageMigrations(
        await readFile(join(bundleDir, MIGRATIONS_DIR, file), 'utf-8'),
        label,
      );

      for (const { from, to } of migrations) {
        // `from` may be an absolute legacy path (inconsistent historical naming).
        const src = resolve(from);
        const dest = resolveTarget(manifest, root, to, `${label} 'to'`);

        if (!(await pathExists(src))) continue; // nothing to migrate
        if (!(await isEmptyOrMissing(dest))) continue; // migrate-if-empty; never clobber

        await mkdir(dirname(dest), { recursive: true });
        await cp(src, dest, { recursive: true });
        await writeFile(
          join(dest, MIGRATION_MARKER),
          `${src}\n${new Date().toISOString()}\n`,
          'utf-8',
        );
      }

      await appendLedgerEntry(
        ledgerPath,
        { file, at: new Date().toISOString(), version: manifest.version },
        !ledgerExists,
      );
      ledgerExists = true;
      done = done.add(file);
    }
  });
}
