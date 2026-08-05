import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareSharedStorage, declaresSharedStorage, sharedStorageDir } from './shared-storage.js';
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
