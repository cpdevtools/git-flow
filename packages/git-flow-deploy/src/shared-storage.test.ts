import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  prepareSharedStorage,
  declaresSharedStorage,
  sharedStorageDir,
  sharedBucketDir,
  versionedBucketDir,
  prepareSeedStorage,
  declaresSeedStorage,
  prepareStorageMigrations,
} from './shared-storage.js';
import type { DeployManifest } from './types.js';

let baseDir: string;

const manifest: DeployManifest = {
  name: '@org/my-service',
  version: '1.0.0',
  repo: 'owner/repo',
  releaseId: 1,
  deployCommand: 'run',
};

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'shared-storage-test-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

describe('prepareSharedStorage', () => {
  it('is a no-op when sharedStorage is absent', async () => {
    await prepareSharedStorage({ ...manifest }, baseDir);
    expect(await dirExists(join(baseDir, 'org-my-service'))).toBe(false);
  });

  it('creates only the service dir when sharedStorage is true', async () => {
    await prepareSharedStorage({ ...manifest, sharedStorage: true }, baseDir);
    expect(await dirExists(join(baseDir, 'org-my-service'))).toBe(true);
  });

  it('creates the service dir when sharedStorage is an empty array', async () => {
    await prepareSharedStorage({ ...manifest, sharedStorage: [] }, baseDir);
    expect(await dirExists(join(baseDir, 'org-my-service'))).toBe(true);
  });

  it('is a no-op when sharedStorage is false', async () => {
    await prepareSharedStorage({ ...manifest, sharedStorage: false }, baseDir);
    expect(await dirExists(join(baseDir, 'org-my-service'))).toBe(false);
  });

  it('creates service dir and each named subdir', async () => {
    await prepareSharedStorage({ ...manifest, sharedStorage: ['data', 'logs'] }, baseDir);
    expect(await dirExists(join(baseDir, 'org-my-service', 'data'))).toBe(true);
    expect(await dirExists(join(baseDir, 'org-my-service', 'logs'))).toBe(true);
  });

  it('creates nested subdirs', async () => {
    await prepareSharedStorage({ ...manifest, sharedStorage: ['data/archive'] }, baseDir);
    expect(await dirExists(join(baseDir, 'org-my-service', 'data', 'archive'))).toBe(true);
  });

  it('is idempotent — no error when dirs already exist', async () => {
    await prepareSharedStorage({ ...manifest, sharedStorage: ['data'] }, baseDir);
    await expect(
      prepareSharedStorage({ ...manifest, sharedStorage: ['data'] }, baseDir),
    ).resolves.not.toThrow();
  });

  it('throws for an absolute path entry', async () => {
    await expect(
      prepareSharedStorage({ ...manifest, sharedStorage: ['/etc/passwd'] }, baseDir),
    ).rejects.toThrow('relative');
  });

  it('throws for an entry containing ..', async () => {
    await expect(
      prepareSharedStorage({ ...manifest, sharedStorage: ['../escape'] }, baseDir),
    ).rejects.toThrow();
  });

  it('throws for an entry that resolves outside the service dir', async () => {
    // Symlink-free path traversal attempt via nested ./.. pattern after resolution
    await expect(
      prepareSharedStorage({ ...manifest, sharedStorage: ['a/../../outside'] }, baseDir),
    ).rejects.toThrow();
  });
});

describe('declaresSharedStorage', () => {
  it('is true for true, an empty array and a populated array', () => {
    expect(declaresSharedStorage({ ...manifest, sharedStorage: true })).toBe(true);
    expect(declaresSharedStorage({ ...manifest, sharedStorage: [] })).toBe(true);
    expect(declaresSharedStorage({ ...manifest, sharedStorage: ['data'] })).toBe(true);
  });

  it('is false when absent or false', () => {
    expect(declaresSharedStorage({ ...manifest })).toBe(false);
    expect(declaresSharedStorage({ ...manifest, sharedStorage: false })).toBe(false);
  });
});

describe('sharedStorageDir', () => {
  it('matches the __SERVICE__ token, not the raw package name', () => {
    expect(sharedStorageDir(manifest, '/shared')).toBe('/shared/org-my-service');
  });
});

describe('prepareSeedStorage', () => {
  let bundleDir: string;

  beforeEach(async () => {
    bundleDir = await mkdtemp(join(tmpdir(), 'seed-bundle-test-'));
    await mkdir(join(bundleDir, 'seed'), { recursive: true });
    await writeFile(join(bundleDir, 'seed', 'repos.json'), '{"allow":["a/*"],"deny":[]}');
  });

  afterEach(async () => {
    await rm(bundleDir, { recursive: true, force: true });
  });

  const seed = { from: 'seed/repos.json', to: 'repos-config/repos.json' };
  const dest = () => join(baseDir, 'org-my-service', 'repos-config', 'repos.json');

  it('is a no-op when seedStorage is absent', async () => {
    await prepareSeedStorage({ ...manifest }, baseDir, bundleDir);
    expect(await dirExists(join(baseDir, 'org-my-service'))).toBe(false);
  });

  it('copies the file when the target is missing', async () => {
    await prepareSeedStorage({ ...manifest, seedStorage: [seed] }, baseDir, bundleDir);
    expect(await readFile(dest(), 'utf-8')).toBe('{"allow":["a/*"],"deny":[]}');
  });

  it('does not overwrite an existing target (seed-if-missing)', async () => {
    await mkdir(join(baseDir, 'org-my-service', 'repos-config'), { recursive: true });
    await writeFile(dest(), 'EDITED');
    await prepareSeedStorage({ ...manifest, seedStorage: [seed] }, baseDir, bundleDir);
    expect(await readFile(dest(), 'utf-8')).toBe('EDITED');
  });

  it('throws when from escapes the bundle', async () => {
    await expect(
      prepareSeedStorage(
        { ...manifest, seedStorage: [{ from: '../secret', to: 'x' }] },
        baseDir,
        bundleDir,
      ),
    ).rejects.toThrow();
  });

  it('throws when to escapes the service dir', async () => {
    await expect(
      prepareSeedStorage(
        { ...manifest, seedStorage: [{ from: 'seed/repos.json', to: '../escape' }] },
        baseDir,
        bundleDir,
      ),
    ).rejects.toThrow();
  });
});

describe('declaresSeedStorage', () => {
  it('is true only for a populated array', () => {
    expect(
      declaresSeedStorage({ ...manifest, seedStorage: [{ from: 'a', to: 'b' }] }),
    ).toBe(true);
    expect(declaresSeedStorage({ ...manifest, seedStorage: [] })).toBe(false);
    expect(declaresSeedStorage({ ...manifest })).toBe(false);
  });
});

// ── Stacked layout ({stack}/{service}/{shared|v{major}}) ─────────────────────

const stacked: DeployManifest = { ...manifest, stack: 'webservice', version: '2.4.1' };

describe('stacked layout paths', () => {
  it('roots the service under the stack segment', () => {
    expect(sharedStorageDir(stacked, '/base')).toBe('/base/webservice/org-my-service');
  });

  it('derives the shared and per-major buckets', () => {
    expect(sharedBucketDir(stacked, '/base')).toBe('/base/webservice/org-my-service/shared');
    expect(versionedBucketDir(stacked, '/base')).toBe('/base/webservice/org-my-service/v2');
  });

  it('uses manifest.service for the service segment when set', () => {
    const svc: DeployManifest = { ...stacked, service: 'my-service' };
    expect(sharedStorageDir(svc, '/base')).toBe('/base/webservice/my-service');
    expect(sharedBucketDir(svc, '/base')).toBe('/base/webservice/my-service/shared');
  });
});

describe('prepareSharedStorage (stacked)', () => {
  it('creates both buckets even when sharedStorage is true', async () => {
    await prepareSharedStorage({ ...stacked, sharedStorage: true }, baseDir);
    expect(await dirExists(join(baseDir, 'webservice', 'org-my-service', 'shared'))).toBe(true);
    expect(await dirExists(join(baseDir, 'webservice', 'org-my-service', 'v2'))).toBe(true);
  });

  it('places a bare array under the shared bucket', async () => {
    await prepareSharedStorage({ ...stacked, sharedStorage: ['repos-config'] }, baseDir);
    expect(
      await dirExists(join(baseDir, 'webservice', 'org-my-service', 'shared', 'repos-config')),
    ).toBe(true);
  });

  it('splits object form across shared and versioned buckets', async () => {
    await prepareSharedStorage(
      { ...stacked, sharedStorage: { shared: ['uploads'], versioned: ['cache'] } },
      baseDir,
    );
    expect(
      await dirExists(join(baseDir, 'webservice', 'org-my-service', 'shared', 'uploads')),
    ).toBe(true);
    expect(await dirExists(join(baseDir, 'webservice', 'org-my-service', 'v2', 'cache'))).toBe(true);
  });

  it('rejects a versioned entry that escapes its bucket', async () => {
    await expect(
      prepareSharedStorage({ ...stacked, sharedStorage: { versioned: ['../escape'] } }, baseDir),
    ).rejects.toThrow();
  });
});

describe('prepareSeedStorage (stacked)', () => {
  let bundleDir: string;

  beforeEach(async () => {
    bundleDir = await mkdtemp(join(tmpdir(), 'seed-stacked-'));
    await mkdir(join(bundleDir, 'seed'), { recursive: true });
    await writeFile(join(bundleDir, 'seed', 'repos.json'), 'SEED');
  });

  afterEach(async () => {
    await rm(bundleDir, { recursive: true, force: true });
  });

  it('seeds into the shared bucket for a shared/ target', async () => {
    await prepareSeedStorage(
      { ...stacked, seedStorage: [{ from: 'seed/repos.json', to: 'shared/repos-config/repos.json' }] },
      baseDir,
      bundleDir,
    );
    const dest = join(baseDir, 'webservice', 'org-my-service', 'shared', 'repos-config', 'repos.json');
    expect(await readFile(dest, 'utf-8')).toBe('SEED');
  });

  it('maps a versioned/ target onto the per-major bucket', async () => {
    await prepareSeedStorage(
      { ...stacked, seedStorage: [{ from: 'seed/repos.json', to: 'versioned/state.json' }] },
      baseDir,
      bundleDir,
    );
    const dest = join(baseDir, 'webservice', 'org-my-service', 'v2', 'state.json');
    expect(await readFile(dest, 'utf-8')).toBe('SEED');
  });
});

describe('prepareStorageMigrations', () => {
  let bundleDir: string;
  let legacyDir: string;

  beforeEach(async () => {
    bundleDir = await mkdtemp(join(tmpdir(), 'migrate-bundle-'));
    legacyDir = await mkdtemp(join(tmpdir(), 'migrate-legacy-'));
    await writeFile(join(legacyDir, 'repos.json'), 'LEGACY');
  });

  afterEach(async () => {
    await rm(bundleDir, { recursive: true, force: true });
    await rm(legacyDir, { recursive: true, force: true });
  });

  const writeMigrations = (to: string) =>
    writeFile(
      join(bundleDir, 'storage-migrations.yml'),
      `migrations:\n  - from: ${legacyDir}\n    to: ${to}\n`,
    );

  it('is a no-op when the bundle has no storage-migrations.yml', async () => {
    await prepareStorageMigrations(stacked, baseDir, bundleDir);
    expect(await dirExists(join(baseDir, 'webservice', 'org-my-service'))).toBe(false);
  });

  it('copies legacy data into the target bucket and writes a marker', async () => {
    await writeMigrations('shared/repos-config');
    await prepareStorageMigrations(stacked, baseDir, bundleDir);
    const target = join(baseDir, 'webservice', 'org-my-service', 'shared', 'repos-config');
    expect(await readFile(join(target, 'repos.json'), 'utf-8')).toBe('LEGACY');
    expect(await readFile(join(target, '.migrated-from'), 'utf-8')).toContain(legacyDir);
    // Copy, not move: the source survives.
    expect(await readFile(join(legacyDir, 'repos.json'), 'utf-8')).toBe('LEGACY');
  });

  it('does not clobber a non-empty target (migrate-if-empty)', async () => {
    const target = join(baseDir, 'webservice', 'org-my-service', 'shared', 'repos-config');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'repos.json'), 'NEWER');
    await writeMigrations('shared/repos-config');
    await prepareStorageMigrations(stacked, baseDir, bundleDir);
    expect(await readFile(join(target, 'repos.json'), 'utf-8')).toBe('NEWER');
    expect(await dirExists(join(target))).toBe(true);
    await expect(readFile(join(target, '.migrated-from'), 'utf-8')).rejects.toThrow();
  });

  it('skips when the source path does not exist', async () => {
    await writeFile(
      join(bundleDir, 'storage-migrations.yml'),
      `migrations:\n  - from: /nonexistent/legacy/path\n    to: shared/repos-config\n`,
    );
    await prepareStorageMigrations(stacked, baseDir, bundleDir);
    expect(
      await dirExists(join(baseDir, 'webservice', 'org-my-service', 'shared', 'repos-config')),
    ).toBe(false);
  });
});
