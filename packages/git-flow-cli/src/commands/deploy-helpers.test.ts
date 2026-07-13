import { describe, it, expect } from 'vitest';
import {
  versionFromTag,
  packageFromTag,
  parseRepoFromUrl,
  compareVersions,
  groupByPackage,
  resolveVersionKeyword,
  buildVersionChoices,
  type GHRelease,
} from './deploy-helpers.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function release(
  id: number,
  tag: string,
  opts: { prerelease?: boolean; draft?: boolean } = {},
): GHRelease {
  return {
    id,
    tag_name: tag,
    name: tag,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    target_commitish: 'main',
    created_at: new Date(id * 1000).toISOString(),
    assets: [{ name: 'deploy.zip' }],
  };
}

// ─── versionFromTag ───────────────────────────────────────────────────────────

describe('versionFromTag', () => {
  it('extracts semver from a gitflow tag', () => {
    expect(versionFromTag('v1.2.3/@org/pkg')).toBe('1.2.3');
    expect(versionFromTag('v0.4.0-dev.5/@org/svc')).toBe('0.4.0-dev.5');
  });

  it('returns the input unchanged when no match', () => {
    expect(versionFromTag('not-a-gitflow-tag')).toBe('not-a-gitflow-tag');
  });
});

// ─── packageFromTag ───────────────────────────────────────────────────────────

describe('packageFromTag', () => {
  it('extracts scoped package name', () => {
    expect(packageFromTag('v1.2.3/@org/pkg')).toBe('@org/pkg');
  });

  it('extracts unscoped package name', () => {
    expect(packageFromTag('v1.0.0/my-service')).toBe('my-service');
  });

  it('returns undefined for non-gitflow tags', () => {
    expect(packageFromTag('v1.0.0')).toBeUndefined();
    expect(packageFromTag('not-a-tag')).toBeUndefined();
  });
});

// ─── parseRepoFromUrl ─────────────────────────────────────────────────────────

describe('parseRepoFromUrl', () => {
  it('parses https URL', () => {
    expect(parseRepoFromUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
    expect(parseRepoFromUrl('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('parses ssh URL', () => {
    expect(parseRepoFromUrl('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(parseRepoFromUrl('git@github.com:owner/repo')).toBe('owner/repo');
  });

  it('throws for non-GitHub URLs', () => {
    expect(() => parseRepoFromUrl('https://gitlab.com/owner/repo.git')).toThrow();
  });
});

// ─── compareVersions ─────────────────────────────────────────────────────────

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('compares major versions', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
  });

  it('compares minor and patch', () => {
    expect(compareVersions('1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.1', '1.0.2')).toBeLessThan(0);
  });

  it('stable sorts above its own pre-release', () => {
    expect(compareVersions('1.0.0', '1.0.0-dev.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-dev.1', '1.0.0')).toBeLessThan(0);
  });

  it('pre-release comparison is consistent', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
  });
});

// ─── groupByPackage ───────────────────────────────────────────────────────────

describe('groupByPackage', () => {
  const releases = [
    release(1, 'v1.0.0/@org/svc'),
    release(2, 'v1.1.0/@org/svc'),
    release(3, 'v1.0.0/@org/app'),
    release(4, 'not-a-gitflow-tag'),
  ];

  it('groups releases by package', () => {
    const groups = groupByPackage(releases);
    expect(Object.keys(groups).sort()).toEqual(['@org/app', '@org/svc']);
    expect(groups['@org/svc']).toHaveLength(2);
    expect(groups['@org/app']).toHaveLength(1);
  });

  it('excludes releases with non-gitflow tags', () => {
    const groups = groupByPackage(releases);
    expect(Object.keys(groups)).not.toContain('not-a-gitflow-tag');
  });

  it('sorts each group newest-first by version', () => {
    const groups = groupByPackage(releases);
    const svcVersions = groups['@org/svc'].map((r) => versionFromTag(r.tag_name));
    expect(svcVersions).toEqual(['1.1.0', '1.0.0']);
  });
});

// ─── resolveVersionKeyword ────────────────────────────────────────────────────

describe('resolveVersionKeyword', () => {
  // Sorted newest-first (as groupByPackage would produce)
  const releases = [
    release(4, 'v2.0.0-dev.1/@org/svc', { prerelease: true }),
    release(3, 'v1.1.0/@org/svc'),
    release(2, 'v1.0.0-rc.1/@org/svc', { prerelease: true }),
    release(1, 'v1.0.0/@org/svc'),
  ];

  it('"next" returns the overall newest (including pre-release)', () => {
    const r = resolveVersionKeyword('next', releases);
    expect(r?.id).toBe(4);
  });

  it('"latest" returns the highest stable version', () => {
    const r = resolveVersionKeyword('latest', releases);
    expect(r?.id).toBe(3);
  });

  it('explicit version matches by semver string', () => {
    const r = resolveVersionKeyword('1.0.0', releases);
    expect(r?.id).toBe(1);
  });

  it('returns undefined when explicit version is not found', () => {
    expect(resolveVersionKeyword('9.9.9', releases)).toBeUndefined();
  });

  it('returns undefined for "latest" when no stable releases exist', () => {
    const preOnly = releases.filter((r) => r.prerelease);
    expect(resolveVersionKeyword('latest', preOnly)).toBeUndefined();
  });
});

// ─── buildVersionChoices ──────────────────────────────────────────────────────

describe('buildVersionChoices', () => {
  const releases = [
    release(4, 'v2.0.0-dev.1/@org/svc', { prerelease: true }),
    release(3, 'v1.1.0/@org/svc'),
    release(2, 'v1.0.0-rc.1/@org/svc', { prerelease: true }),
    release(1, 'v1.0.0/@org/svc'),
  ];

  it('puts next first and latest second', () => {
    const choices = buildVersionChoices(releases);
    expect(choices[0].title).toMatch(/^next/);
    expect(choices[1].title).toMatch(/^latest/);
  });

  it('next points at the newest release overall', () => {
    const choices = buildVersionChoices(releases);
    expect((choices[0].value as GHRelease).id).toBe(4);
  });

  it('latest points at the newest stable release', () => {
    const choices = buildVersionChoices(releases);
    expect((choices[1].value as GHRelease).id).toBe(3);
  });

  it('includes additional recent releases after next/latest', () => {
    const choices = buildVersionChoices(releases);
    const ids = choices.map((c) => (c.value as GHRelease).id);
    // All 4 distinct releases should appear
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
    expect(ids).toContain(4);
  });

  it('never duplicates the same release', () => {
    const choices = buildVersionChoices(releases);
    const ids = choices.map((c) => (c.value as GHRelease).id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('when next === latest (stable is newest), only one top entry', () => {
    const stableOnly = [release(2, 'v2.0.0/@org/svc'), release(1, 'v1.0.0/@org/svc')];
    const choices = buildVersionChoices(stableOnly);
    // next and latest are the same release — only one top entry
    expect(choices[0].title).toMatch(/^next/);
    expect(choices.find((c) => (c.title as string).startsWith('latest'))).toBeUndefined();
  });
});
