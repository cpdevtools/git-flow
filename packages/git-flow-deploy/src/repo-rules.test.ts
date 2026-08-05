import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isRepoAllowed,
  readReposConfig,
  writeReposConfig,
  reposConfigPath,
  DEFAULT_REPOS_CONFIG_PATH,
} from './repo-rules.js';

const dirs: string[] = [];

async function tempConfig(contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repo-rules-'));
  dirs.push(dir);
  const file = join(dir, 'repos.json');
  if (contents !== undefined) await writeFile(file, contents, 'utf-8');
  return file;
}

afterEach(async () => {
  delete process.env['DEPLOY_REPOS_CONFIG'];
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('isRepoAllowed', () => {
  it('permits everything when no rules are set', () => {
    expect(isRepoAllowed('anyone/anything', { allow: [], deny: [] })).toBe(true);
  });

  it('treats a non-empty allow list as exclusive', () => {
    const config = { allow: ['owner/*'], deny: [] };
    expect(isRepoAllowed('owner/repo', config)).toBe(true);
    expect(isRepoAllowed('other/repo', config)).toBe(false);
  });

  it('lets deny win over allow', () => {
    const config = { allow: ['owner/*'], deny: ['owner/secret'] };
    expect(isRepoAllowed('owner/repo', config)).toBe(true);
    expect(isRepoAllowed('owner/secret', config)).toBe(false);
  });

  it('applies deny when the allow list is empty', () => {
    const config = { allow: [], deny: ['*/secret'] };
    expect(isRepoAllowed('owner/repo', config)).toBe(true);
    expect(isRepoAllowed('owner/secret', config)).toBe(false);
  });

  // Pinned because the C# gateway reimplements these against DotNet.Glob.
  it.each([
    ['*', 'owner/repo', false],
    ['**', 'owner/repo', true],
    ['owner/*', 'owner/repo', true],
    ['owner/*', 'owner/sub/repo', false],
    ['owner/**', 'owner/sub/repo', true],
    ['*/repo', 'owner/repo', true],
    ['owner/re*', 'owner/repo', true],
    ['owner/?epo', 'owner/repo', true],
    ['{owner,other}/repo', 'owner/repo', true],
    ['{owner,other}/repo', 'third/repo', false],
    ['{a,{b,c}}/repo', 'c/repo', true],
    ['{owner}/repo', 'owner/repo', false],
    ['{owner/repo', 'owner/repo', false],
    ['owner/repo', 'Owner/Repo', false],
  ])('matches %s against %s', (pattern, repo, expected) => {
    expect(isRepoAllowed(repo, { allow: [pattern as string], deny: [] })).toBe(expected);
  });
});

describe('reposConfigPath', () => {
  it('prefers the explicit override, then the env var, then the default', () => {
    expect(reposConfigPath('/explicit.json')).toBe('/explicit.json');
    process.env['DEPLOY_REPOS_CONFIG'] = '/from-env.json';
    expect(reposConfigPath()).toBe('/from-env.json');
    delete process.env['DEPLOY_REPOS_CONFIG'];
    expect(reposConfigPath()).toBe(DEFAULT_REPOS_CONFIG_PATH);
  });
});

describe('readReposConfig', () => {
  it('returns an empty config when the file is absent', async () => {
    const file = await tempConfig();
    await expect(readReposConfig(file)).resolves.toEqual({ allow: [], deny: [] });
  });

  it('throws rather than reading corrupt JSON as "no rules"', async () => {
    const file = await tempConfig('{ not json');
    await expect(readReposConfig(file)).rejects.toThrow(/not valid JSON/);
  });

  it('coerces missing or non-array fields to empty lists', async () => {
    const file = await tempConfig(JSON.stringify({ allow: 'owner/*' }));
    await expect(readReposConfig(file)).resolves.toEqual({ allow: [], deny: [] });
  });

  it('round-trips through writeReposConfig', async () => {
    const file = await tempConfig();
    await writeReposConfig({ allow: ['owner/*'], deny: ['owner/secret'] }, file);
    await expect(readReposConfig(file)).resolves.toEqual({
      allow: ['owner/*'],
      deny: ['owner/secret'],
    });
  });
});
