import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreProjectFiles } from './index.js';

describe('restoreProjectFiles', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  const ORIGINAL = '{"name":"pkg","version":"0.0.0-PLACEHOLDER"}\n';

  async function project(name: string, tracked = true): Promise<string> {
    const cwd = join(repo, 'packages', name);
    await mkdir(cwd, { recursive: true });
    if (tracked) await writeFile(join(cwd, 'package.json'), ORIGINAL);
    return cwd;
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'git-restore-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('restores many projects concurrently without losing the index lock', async () => {
    const projects = await Promise.all(
      Array.from({ length: 12 }, (_, i) => project(`p${i}`)),
    );
    git('add', '.');
    git('commit', '-qm', 'init');
    for (const cwd of projects) await writeFile(join(cwd, 'package.json'), '{"stamped":true}\n');

    await Promise.all(projects.map((cwd) => restoreProjectFiles(cwd)));

    for (const cwd of projects) {
      expect(await readFile(join(cwd, 'package.json'), 'utf-8')).toBe(ORIGINAL);
    }
  });

  it('ignores a project with no tracked package.json', async () => {
    await project('tracked');
    git('add', '.');
    git('commit', '-qm', 'init');
    const dotnet = await project('dotnet', false);

    await expect(restoreProjectFiles(dotnet)).resolves.toBeUndefined();
  });

  it('waits out an index.lock held by another git process', async () => {
    const cwd = await project('locked');
    git('add', '.');
    git('commit', '-qm', 'init');
    await writeFile(join(cwd, 'package.json'), '{"stamped":true}\n');
    const lock = join(repo, '.git', 'index.lock');
    await writeFile(lock, '');
    setTimeout(() => void rm(lock, { force: true }), 300);

    await restoreProjectFiles(cwd);

    expect(await readFile(join(cwd, 'package.json'), 'utf-8')).toBe(ORIGINAL);
  });

  it('fails when the file cannot be restored', async () => {
    const cwd = await project('stuck');
    git('add', '.');
    git('commit', '-qm', 'init');
    await writeFile(join(repo, '.git', 'index.lock'), '');

    await expect(restoreProjectFiles(cwd)).rejects.toThrow(/index\.lock/);
  }, 15_000);
});
