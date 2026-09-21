import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadContext } from '../artifacts/index.js';

const uploadArtifact = vi.fn(async (..._args: unknown[]) => {});
vi.mock('./github.js', () => ({ uploadArtifact: (...args: unknown[]) => uploadArtifact(...args) }));

const { uploadDeployBundle } = await import('./deploy-bundle.js');

const unzipFile = (zip: string, file: string): string =>
  execFileSync('unzip', ['-p', zip, file], { encoding: 'utf-8' });

describe('uploadDeployBundle', () => {
  let root: string;
  let outputDir: string;

  /** A project's rendered deploy output: same file names in every project. */
  async function deployOutput(name: string, service: string): Promise<string> {
    const dir = join(root, name, '.deploy-output', 'swarm');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'deploy.yml'), `name: ${name}\ndeployCommand: ./deploy.sh\n`);
    await writeFile(join(dir, 'stack.yml'), `services:\n  ${service}: {}\n`);
    return dir;
  }

  const ctx = (releaseId: number): UploadContext =>
    ({ githubToken: 't', owner: 'o', repo: 'r', releaseId, uploadUrl: 'u' }) as UploadContext;

  beforeEach(async () => {
    uploadArtifact.mockClear();
    root = await mkdtemp(join(tmpdir(), 'deploy-bundle-'));
    outputDir = join(root, 'artifacts');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps concurrently packed projects in separate zips under one asset name', async () => {
    const [a, b] = await Promise.all([
      deployOutput('ideallink-app', 'ideallink'),
      deployOutput('punchout-app', 'punchout'),
    ]);

    const [zipA, zipB] = await Promise.all([
      uploadDeployBundle('ideallink-app', 'swarm', a, ctx(1), outputDir),
      uploadDeployBundle('punchout-app', 'swarm', b, ctx(2), outputDir),
    ]);

    expect(zipA).not.toBe(zipB);
    expect((await readdir(outputDir)).sort()).toEqual(
      ['ideallink-app-deploy-swarm.zip', 'punchout-app-deploy-swarm.zip'].sort(),
    );
    expect(unzipFile(zipA, 'deploy.yml')).toContain('name: ideallink-app');
    expect(unzipFile(zipA, 'stack.yml')).toContain('ideallink:');
    expect(unzipFile(zipB, 'deploy.yml')).toContain('name: punchout-app');
    expect(unzipFile(zipB, 'stack.yml')).toContain('punchout:');

    expect(uploadArtifact).toHaveBeenCalledTimes(2);
    const calls = uploadArtifact.mock.calls.map((c) => ({
      releaseId: c[3],
      filePath: c[5],
      assetName: c[6],
    }));
    expect(calls).toContainEqual({ releaseId: 1, filePath: zipA, assetName: 'deploy-swarm.zip' });
    expect(calls).toContainEqual({ releaseId: 2, filePath: zipB, assetName: 'deploy-swarm.zip' });
  });

  it('replaces a stale archive instead of updating it', async () => {
    const dir = await deployOutput('@org/svc', 'svc');
    await writeFile(join(dir, 'stale.txt'), 'from an earlier run');
    const zip = await uploadDeployBundle('@org/svc', 'swarm', dir, ctx(1), outputDir);

    await rm(join(dir, 'stale.txt'));
    await uploadDeployBundle('@org/svc', 'swarm', dir, ctx(1), outputDir);

    const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf-8' });
    expect(entries).toContain('deploy.yml');
    expect(entries).not.toContain('stale.txt');
  });
});
