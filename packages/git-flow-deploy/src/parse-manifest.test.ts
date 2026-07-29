import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDeployYml } from './parse-manifest.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'parse-manifest-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(content: string): Promise<string> {
  const path = join(dir, 'deploy.yml');
  await writeFile(path, content, 'utf-8');
  return path;
}

const VALID_BASE = `
name: my-service
version: 1.2.3
repo: owner/repo
releaseId: 42
deployCommand: ./deploy.sh
`;

describe('parseDeployYml', () => {
  it('parses a minimal valid manifest', async () => {
    const path = await write(VALID_BASE);
    const manifest = await parseDeployYml(path);
    expect(manifest.name).toBe('my-service');
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.repo).toBe('owner/repo');
    expect(manifest.releaseId).toBe(42);
    expect(manifest.deployCommand).toBe('./deploy.sh');
    expect(manifest.sharedStorage).toBeUndefined();
  });

  it('parses sharedStorage: true', async () => {
    const path = await write(VALID_BASE + 'sharedStorage: true\n');
    const manifest = await parseDeployYml(path);
    expect(manifest.sharedStorage).toBe(true);
  });

  it('parses sharedStorage as an array of subdirs', async () => {
    const path = await write(VALID_BASE + 'sharedStorage:\n  - data\n  - logs/archive\n');
    const manifest = await parseDeployYml(path);
    expect(manifest.sharedStorage).toEqual(['data', 'logs/archive']);
  });

  describe('required field validation', () => {
    it('throws when name is missing', async () => {
      const path = await write(`version: 1.0.0\nrepo: o/r\nreleaseId: 1\ndeployCommand: run\n`);
      await expect(parseDeployYml(path)).rejects.toThrow('name');
    });

    it('throws when version is missing', async () => {
      const path = await write(`name: svc\nrepo: o/r\nreleaseId: 1\ndeployCommand: run\n`);
      await expect(parseDeployYml(path)).rejects.toThrow('version');
    });

    it('throws when repo is missing', async () => {
      const path = await write(`name: svc\nversion: 1.0.0\nreleaseId: 1\ndeployCommand: run\n`);
      await expect(parseDeployYml(path)).rejects.toThrow('repo');
    });

    it('throws when releaseId is missing', async () => {
      const path = await write(`name: svc\nversion: 1.0.0\nrepo: o/r\ndeployCommand: run\n`);
      await expect(parseDeployYml(path)).rejects.toThrow('releaseId');
    });

    it('throws when deployCommand is missing', async () => {
      const path = await write(`name: svc\nversion: 1.0.0\nrepo: o/r\nreleaseId: 1\n`);
      await expect(parseDeployYml(path)).rejects.toThrow('deployCommand');
    });
  });

  describe('releaseId validation', () => {
    it('throws when releaseId is zero', async () => {
      const path = await write(`name: svc\nversion: 1.0.0\nrepo: o/r\nreleaseId: 0\ndeployCommand: run\n`);
      await expect(parseDeployYml(path)).rejects.toThrow('releaseId');
    });

    it('throws when releaseId is negative', async () => {
      const path = await write(`name: svc\nversion: 1.0.0\nrepo: o/r\nreleaseId: -5\ndeployCommand: run\n`);
      await expect(parseDeployYml(path)).rejects.toThrow('releaseId');
    });
  });

  describe('sharedStorage validation', () => {
    it('throws when sharedStorage entry is an absolute path', async () => {
      const path = await write(VALID_BASE + 'sharedStorage:\n  - /absolute/path\n');
      await expect(parseDeployYml(path)).rejects.toThrow();
    });

    it('throws when sharedStorage entry contains ..', async () => {
      const path = await write(VALID_BASE + 'sharedStorage:\n  - ../escape\n');
      await expect(parseDeployYml(path)).rejects.toThrow();
    });

    it('throws when sharedStorage is a non-boolean scalar', async () => {
      const path = await write(VALID_BASE + 'sharedStorage: 42\n');
      await expect(parseDeployYml(path)).rejects.toThrow('sharedStorage');
    });
  });

  describe('mode-change fields', () => {
    it('parses method, slot, versioning and teardownCommand', async () => {
      const path = await write(
        VALID_BASE +
          'method: compose\n' +
          'slot: my-service-v1\n' +
          'versioning: major\n' +
          'teardownCommand: docker compose -p my-service-v1 down\n',
      );
      const manifest = await parseDeployYml(path);
      expect(manifest.method).toBe('compose');
      expect(manifest.slot).toBe('my-service-v1');
      expect(manifest.versioning).toBe('major');
      expect(manifest.teardownCommand).toBe('docker compose -p my-service-v1 down');
    });

    it('leaves the new fields undefined when absent (legacy bundle)', async () => {
      const path = await write(VALID_BASE);
      const manifest = await parseDeployYml(path);
      expect(manifest.method).toBeUndefined();
      expect(manifest.slot).toBeUndefined();
      expect(manifest.versioning).toBeUndefined();
      expect(manifest.teardownCommand).toBeUndefined();
    });

    it('ignores an unknown versioning value', async () => {
      const path = await write(VALID_BASE + 'versioning: weekly\n');
      const manifest = await parseDeployYml(path);
      expect(manifest.versioning).toBeUndefined();
    });
  });
});
