import { describe, it, expect } from 'vitest';
import {
  versionFromTag,
  packageFromTag,
  parseRepoFromUrl,
  isPrerelease,
  groupByPackage,
  resolveVersionKeyword,
  buildVersionChoices,
  extractArtifactMetadata,
  releaseDeployMethods,
  isDeployable,
  defaultMethod,
  parseWorkflowEnvironment,
  majorFromVersionBranch,
  filterReleasesByMajor,
  filterReleasesByMethods,
  isGitflowTag,
  stripReleasePrefix,
  branchFromMetadata,
  prNumberFromBody,
  branchKeyFromVersion,
  branchFromKey,
  sourceBranchOf,
  prNumbersToLookUp,
  groupBySourceBranch,
  distinctVersions,
  packagesAtVersion,
  dispatchRefCandidates,
  type GHRelease,
} from './deploy-helpers.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Build a release body with an Artifact Metadata block for the given methods per artifact. */
function bodyWithDeploy(
  artifacts: Array<{ type: string; name: string; deploy?: string[]; published?: boolean }>,
): string {
  const lines = artifacts
    .map((a) => {
      const pub = `\n    published: ${a.published ?? true}`;
      const deploy = a.deploy
        ? `\n    deploy:\n${a.deploy.map((m) => `      - ${m}`).join('\n')}`
        : '';
      return `  - type: ${a.type}\n    name: '${a.name}'${pub}${deploy}`;
    })
    .join('\n');
  const yaml = `project: '@org/svc'\nartifacts:\n${lines}`;
  return `📋 **Created from PR:** #12\n\n## Artifact Metadata\n\`\`\`yaml\n${yaml}\n\`\`\``;
}

/** Derive deploy asset names from a body string (deploy-<method>.zip for each advertised method). */
function assetsFromBody(body: string): { name: string }[] {
  const matches = body.matchAll(/^\s*-\s*(\w+)\s*$/gm);
  const methods = new Set<string>();
  // Rough parse: any line that's a bare word under a 'deploy:' key
  const deployBlocks = body.match(/deploy:[\s\S]*?(?=\n  -|\n\w|$)/g) ?? [];
  for (const block of deployBlocks) {
    for (const m of block.matchAll(/^\s*-\s*(\w+)\s*$/gm)) {
      methods.add(m[1]);
    }
  }
  return [...methods].map((m) => ({ name: `deploy-${m}.zip` }));
}

function release(
  id: number,
  tag: string,
  opts: {
    draft?: boolean;
    body?: string | null;
    assets?: { name: string }[];
  } = {},
): GHRelease {
  const body = opts.body ?? bodyWithDeploy([{ type: 'npm', name: '@org/svc', deploy: ['node'] }]);
  return {
    id,
    tag_name: tag,
    name: tag,
    draft: opts.draft ?? false,
    target_commitish: 'main',
    created_at: new Date(id * 1000).toISOString(),
    // Default: auto-derive deploy asset names from the body so tests don't need
    // to manually maintain the asset list alongside the method declarations.
    assets: opts.assets ?? (body ? assetsFromBody(body) : []),
    body,
  };
}

// ─── versionFromTag ───────────────────────────────────────────────────────────

describe('versionFromTag', () => {
  it('extracts semver from a gitflow tag', () => {
    expect(versionFromTag('@org/pkg/v1.2.3')).toBe('1.2.3');
    expect(versionFromTag('@org/svc/v0.4.0-alpha.5')).toBe('0.4.0-alpha.5');
  });

  it('returns the input unchanged when no match', () => {
    expect(versionFromTag('not-a-gitflow-tag')).toBe('not-a-gitflow-tag');
  });
});

// ─── packageFromTag ───────────────────────────────────────────────────────────

describe('packageFromTag', () => {
  it('extracts scoped package name', () => {
    expect(packageFromTag('@org/pkg/v1.2.3')).toBe('@org/pkg');
  });

  it('extracts unscoped package name', () => {
    expect(packageFromTag('my-service/v1.0.0')).toBe('my-service');
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

// ─── groupByPackage ───────────────────────────────────────────────────────────

describe('groupByPackage', () => {
  const releases = [
    release(1, '@org/svc/v1.0.0'),
    release(2, '@org/svc/v1.1.0'),
    release(3, '@org/app/v1.0.0'),
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

// ─── majorFromVersionBranch ───────────────────────────────────────────────────

describe('majorFromVersionBranch', () => {
  it('extracts the major from a versioned release branch', () => {
    expect(majorFromVersionBranch('release/v0')).toBe(0);
    expect(majorFromVersionBranch('release/v1')).toBe(1);
    expect(majorFromVersionBranch('release/v12')).toBe(12);
  });

  it('extracts the major from a bare version branch', () => {
    expect(majorFromVersionBranch('v0')).toBe(0);
    expect(majorFromVersionBranch('v3')).toBe(3);
  });

  it('returns null for non-versioned branches', () => {
    expect(majorFromVersionBranch('release/main')).toBeNull();
    expect(majorFromVersionBranch('main')).toBeNull();
    expect(majorFromVersionBranch('release/v1.2')).toBeNull();
    expect(majorFromVersionBranch('release/feature-v2-thing')).toBeNull();
  });
});

// ─── filterReleasesByMajor ────────────────────────────────────────────────────

describe('filterReleasesByMajor', () => {
  const releases = [
    release(1, '@org/svc/v0.2.2'),
    release(2, '@org/svc/v1.0.0'),
    release(3, '@org/svc/v1.2.0-alpha.0'),
    release(4, '@org/svc/v2.0.0'),
    release(5, 'not-a-gitflow-tag'),
  ];

  it('keeps only releases matching the given major', () => {
    const v1 = filterReleasesByMajor(releases, 1).map((r) => versionFromTag(r.tag_name));
    expect(v1).toEqual(['1.0.0', '1.2.0-alpha.0']);
  });

  it('matches major 0', () => {
    const v0 = filterReleasesByMajor(releases, 0).map((r) => versionFromTag(r.tag_name));
    expect(v0).toEqual(['0.2.2']);
  });

  it('excludes releases with unparseable versions', () => {
    const v1 = filterReleasesByMajor(releases, 1);
    expect(v1.some((r) => r.tag_name === 'not-a-gitflow-tag')).toBe(false);
  });

  it('returns empty when no release matches', () => {
    expect(filterReleasesByMajor(releases, 9)).toEqual([]);
  });
});

// ─── resolveVersionKeyword ────────────────────────────────────────────────────

describe('resolveVersionKeyword', () => {
  // Sorted newest-first (as groupByPackage would produce)
  const releases = [
    release(4, '@org/svc/v2.0.0-alpha.1'),
    release(3, '@org/svc/v1.1.0'),
    release(2, '@org/svc/v1.0.0-rc.1'),
    release(1, '@org/svc/v1.0.0'),
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
    const preOnly = releases.filter((r) => isPrerelease(r));
    expect(resolveVersionKeyword('latest', preOnly)).toBeUndefined();
  });
});

// ─── buildVersionChoices ──────────────────────────────────────────────────────

describe('buildVersionChoices', () => {
  const releases = [
    release(4, '@org/svc/v2.0.0-alpha.1'),
    release(3, '@org/svc/v1.1.0'),
    release(2, '@org/svc/v1.0.0-rc.1'),
    release(1, '@org/svc/v1.0.0'),
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
    const stableOnly = [release(2, '@org/svc/v2.0.0'), release(1, '@org/svc/v1.0.0')];
    const choices = buildVersionChoices(stableOnly);
    // next and latest are the same release — only one top entry
    expect(choices[0].title).toMatch(/^next/);
    expect(choices.find((c) => (c.title as string).startsWith('latest'))).toBeUndefined();
  });
});

// ─── extractArtifactMetadata ────────────────────────────────────────────

describe('extractArtifactMetadata', () => {
  it('parses the Artifact Metadata YAML block', () => {
    const body = bodyWithDeploy([
      { type: 'npm', name: '@org/svc', deploy: ['node'] },
      { type: 'docker', name: 'ghcr.io/org/svc', deploy: ['compose', 'swarm'] },
    ]);
    const descriptor = extractArtifactMetadata(body);
    expect(descriptor?.project).toBe('@org/svc');
    expect(descriptor?.artifacts).toHaveLength(2);
  });

  it('returns undefined when there is no metadata block', () => {
    expect(extractArtifactMetadata('just a plain body')).toBeUndefined();
    expect(extractArtifactMetadata(null)).toBeUndefined();
    expect(extractArtifactMetadata(undefined)).toBeUndefined();
  });
});

// ─── releaseDeployMethods ────────────────────────────────────────────────────

describe('releaseDeployMethods', () => {
  it('unions deploy arrays across artifacts, preserving declaration order', () => {
    const r = release(1, '@org/svc/v1.0.0', {
      body: bodyWithDeploy([
        { type: 'npm', name: '@org/svc', deploy: ['node'] },
        { type: 'docker', name: 'ghcr.io/org/svc', deploy: ['compose', 'swarm'] },
      ]),
    });
    expect(releaseDeployMethods(r)).toEqual(['node', 'compose', 'swarm']);
  });

  it('de-duplicates methods shared across artifacts', () => {
    const r = release(1, '@org/svc/v1.0.0', {
      body: bodyWithDeploy([
        { type: 'npm', name: '@org/svc', deploy: ['node', 'compose'] },
        { type: 'docker', name: 'ghcr.io/org/svc', deploy: ['compose'] },
      ]),
    });
    expect(releaseDeployMethods(r)).toEqual(['node', 'compose']);
  });

  it('returns [] when no artifact declares a deploy array', () => {
    const r = release(1, '@org/svc/v1.0.0', {
      body: bodyWithDeploy([{ type: 'npm', name: '@org/svc' }]),
    });
    expect(releaseDeployMethods(r)).toEqual([]);
  });

  it('returns [] when artifacts have published:false (release mid-publish)', () => {
    const r = release(1, '@org/svc/v1.0.0', {
      body: bodyWithDeploy([
        { type: 'docker', name: 'ghcr.io/org/svc', deploy: ['compose'], published: false },
      ]),
    });
    expect(releaseDeployMethods(r)).toEqual([]);
  });
});

// ─── isDeployable ───────────────────────────────────────────────────────────

describe('isDeployable', () => {
  it('is true when the release advertises a deploy method', () => {
    expect(isDeployable(release(1, '@org/svc/v1.0.0'))).toBe(true);
  });

  it('is false when no deploy method is advertised', () => {
    const r = release(1, '@org/svc/v1.0.0', {
      body: bodyWithDeploy([{ type: 'npm', name: '@org/svc' }]),
    });
    expect(isDeployable(r)).toBe(false);
  });

  it('is false when there is no metadata block at all', () => {
    expect(isDeployable(release(1, '@org/svc/v1.0.0', { body: 'plain body' }))).toBe(false);
  });
});

// ─── defaultMethod ──────────────────────────────────────────────────────────

describe('defaultMethod', () => {
  it('returns the first method in declaration order', () => {
    expect(defaultMethod(['node', 'compose', 'swarm'])).toBe('node');
  });

  it('returns undefined for an empty list', () => {
    expect(defaultMethod([])).toBeUndefined();
  });
});

// ─── parseWorkflowEnvironment ────────────────────────────────────────────────

describe('parseWorkflowEnvironment', () => {
  it('reads a string jobs.deploy.environment', () => {
    const yml = [
      'jobs:',
      '  deploy:',
      '    runs-on: ubuntu-latest',
      '    environment: "Deploy Test"',
    ].join('\n');
    expect(parseWorkflowEnvironment(yml)).toBe('Deploy Test');
  });

  it('reads an object jobs.deploy.environment.name', () => {
    const yml = [
      'jobs:',
      '  deploy:',
      '    environment:',
      '      name: production',
      '      url: https://example.com',
    ].join('\n');
    expect(parseWorkflowEnvironment(yml)).toBe('production');
  });

  it('returns undefined when environment is absent', () => {
    const yml = ['jobs:', '  deploy:', '    runs-on: ubuntu-latest'].join('\n');
    expect(parseWorkflowEnvironment(yml)).toBeUndefined();
  });

  it('returns undefined for malformed YAML', () => {
    expect(parseWorkflowEnvironment('jobs: [unclosed')).toBeUndefined();
  });
});

// ─── source branch mapping ────────────────────────────────────────────────────

const ORIGIN = ['main', 'release/main', 'feature/wirecut', 'release/feature/wirecut', 'qq/asdf'];

/** Release body whose metadata records the source branch / PR (new build-pack format). */
function bodyWithSource(branch?: string, pr?: number): string {
  const source = `${branch ? `branch: ${branch}\n` : ''}${pr ? `pr: ${pr}\n` : ''}`;
  const yaml = `project: '@org/svc'\n${source}artifacts:\n  - type: npm\n    name: '@org/svc'\n    published: true\n    deploy:\n      - node`;
  return `## Artifact Metadata\n\`\`\`yaml\n${yaml}\n\`\`\``;
}

describe('stripReleasePrefix', () => {
  it('strips only a leading release/', () => {
    expect(stripReleasePrefix('release/feature/x')).toBe('feature/x');
    expect(stripReleasePrefix('feature/release/x')).toBe('feature/release/x');
    expect(stripReleasePrefix('main')).toBe('main');
  });
});

describe('prNumberFromBody / branchFromMetadata', () => {
  it('reads the PR number from the Created-from-PR line', () => {
    expect(prNumberFromBody(release(1, '@org/svc/v1.0.0').body)).toBe(12);
  });

  it('prefers the metadata pr key', () => {
    expect(prNumberFromBody(bodyWithSource('main', 205))).toBe(205);
  });

  it('returns undefined when there is no PR', () => {
    expect(prNumberFromBody(null)).toBeUndefined();
    expect(prNumberFromBody('no pr here')).toBeUndefined();
  });

  it('reads the branch from the metadata, when recorded', () => {
    expect(
      branchFromMetadata(release(1, '@org/svc/v1.0.0', { body: bodyWithSource('qq/asdf') })),
    ).toBe('qq/asdf');
    expect(branchFromMetadata(release(1, '@org/svc/v1.0.0'))).toBeUndefined();
  });
});

describe('branchKeyFromVersion', () => {
  it.each([
    ['3.0.0-erd.wire-cut.batched-ids.alpha.1.build.99', 'erd.wire-cut.batched-ids'],
    ['3.0.0-feature.wirecut.alpha.2', 'feature.wirecut'],
    ['3.0.0-alpha.2', ''],
    ['3.0.0-rc.0.build.4', ''],
    ['3.0.0', ''],
    ['1.2.3-main.build.5', 'main'],
    ['1.2.3-feature.x', 'feature.x'],
    ['1.2.3-feature.alpha.tools.beta.1', 'feature.alpha.tools'],
  ])('%s → "%s"', (version, key) => {
    expect(branchKeyFromVersion(version)).toBe(key);
  });
});

describe('branchFromKey', () => {
  it('matches forward against sanitized remote branches', () => {
    const remote = [...ORIGIN, 'erd/wire-cut/batched-ids', 'fix/a.b'];
    expect(branchFromKey('erd.wire-cut.batched-ids', 3, remote, 'main')).toBe(
      'erd/wire-cut/batched-ids',
    );
    expect(branchFromKey('fix.a.b', 3, remote, 'main')).toBe('fix/a.b');
  });

  it('matches a branch that only survives as its release/ counterpart', () => {
    expect(branchFromKey('feature.gone', 3, ['release/feature/gone'], 'main')).toBe(
      'feature/gone',
    );
  });

  it('falls back to dots→slashes for a deleted branch', () => {
    expect(branchFromKey('www.qwerty', 3, ORIGIN, 'main')).toBe('www/qwerty');
  });

  it('maps mainline to v<major> when that branch exists, else the default branch', () => {
    expect(branchFromKey('', 3, ORIGIN, 'main')).toBe('main');
    expect(branchFromKey('', 3, [...ORIGIN, 'v3'], 'main')).toBe('v3');
    expect(branchFromKey('', 3, [...ORIGIN, 'release/v3'], 'main')).toBe('v3');
    expect(branchFromKey('', 2, [...ORIGIN, 'v3'], 'trunk')).toBe('trunk');
  });
});

describe('sourceBranchOf', () => {
  const prHeads = new Map([[12, 'feature/wirecut']]);

  it('prefers the metadata branch over the PR and the version', () => {
    const r = release(1, '@org/svc/v3.0.0-qq.asdf.alpha.1', {
      body: `📋 **Created from PR:** #12\n\n${bodyWithSource('from/yaml')}`,
    });
    expect(sourceBranchOf(r, prHeads, ORIGIN, 'main')).toBe('from/yaml');
  });

  it('uses the PR head when the metadata has no branch', () => {
    const r = release(1, '@org/svc/v3.0.0-qq.asdf.alpha.1');
    expect(sourceBranchOf(r, prHeads, ORIGIN, 'main')).toBe('feature/wirecut');
  });

  it('parses the version when the PR lookup has nothing', () => {
    const empty = new Map<number, string>();
    expect(
      sourceBranchOf(release(1, '@org/svc/v3.0.0-qq.asdf.alpha.1'), empty, ORIGIN, 'main'),
    ).toBe('qq/asdf');
    expect(sourceBranchOf(release(2, '@org/svc/v3.0.0-alpha.2'), empty, ORIGIN, 'main')).toBe(
      'main',
    );
  });
});

describe('prNumbersToLookUp', () => {
  it('lists distinct PRs of releases without a metadata branch', () => {
    const releases = [
      release(1, '@org/a/v1.0.0'),
      release(2, '@org/b/v1.0.0'),
      release(3, '@org/c/v1.0.0', { body: bodyWithSource('main', 99) }),
    ];
    expect(prNumbersToLookUp(releases)).toEqual([12]);
  });
});

describe('groupBySourceBranch', () => {
  const releases = [
    release(10, '@org/a/v3.0.0-alpha.2'),
    release(30, '@org/a/v3.0.0-feature.wirecut.alpha.2'),
    release(20, '@org/b/v3.0.0-feature.wirecut.alpha.2'),
    release(40, '@org/a/v3.0.0-www.qwerty.alpha.2'),
  ];
  const branchOf = (r: GHRelease) => sourceBranchOf(r, new Map(), ORIGIN, 'main');

  it('groups releases and flags branches gone from origin', () => {
    const groups = groupBySourceBranch(releases, branchOf, ORIGIN, 'main', 'main');
    expect(groups.map((g) => [g.branch, g.exists, g.releases.length])).toEqual([
      ['main', true, 1],
      ['www/qwerty', false, 1],
      ['feature/wirecut', true, 2],
    ]);
  });

  it('puts the current branch first, then the default branch', () => {
    const groups = groupBySourceBranch(
      releases,
      branchOf,
      ORIGIN,
      'release/feature/wirecut',
      'main',
    );
    expect(groups.map((g) => g.branch)).toEqual(['feature/wirecut', 'main', 'www/qwerty']);
  });
});

describe('distinctVersions / packagesAtVersion', () => {
  const releases = [
    release(1, '@org/a/v1.0.0'),
    release(2, '@org/b/v1.0.0'),
    release(3, '@org/a/v1.1.0-alpha.0'),
    release(4, 'not-a-gitflow-tag'),
  ];

  it('lists each version once, newest first', () => {
    expect(distinctVersions(releases).map((r) => versionFromTag(r.tag_name))).toEqual([
      '1.1.0-alpha.0',
      '1.0.0',
    ]);
  });

  it('feeds resolveVersionKeyword across packages', () => {
    const versions = distinctVersions(releases);
    expect(versionFromTag(resolveVersionKeyword('latest', versions)!.tag_name)).toBe('1.0.0');
    expect(versionFromTag(resolveVersionKeyword('next', versions)!.tag_name)).toBe(
      '1.1.0-alpha.0',
    );
  });

  it('returns only the packages that have the version', () => {
    expect(Object.keys(packagesAtVersion(releases, '1.0.0')).sort()).toEqual(['@org/a', '@org/b']);
    expect(Object.keys(packagesAtVersion(releases, '1.1.0-alpha.0'))).toEqual(['@org/a']);
    expect(packagesAtVersion(releases, '1.0.0')['@org/b'].id).toBe(2);
  });
});

describe('filterReleasesByMethods', () => {
  const node = release(1, '@org/a/v1.0.0');
  const compose = release(2, '@org/b/v1.0.0', {
    body: bodyWithDeploy([{ type: 'docker-image', name: 'b', deploy: ['compose'] }]),
  });

  it('keeps releases advertising an allowed method', () => {
    expect(filterReleasesByMethods([node, compose], ['compose', 'swarm'])).toEqual([compose]);
  });

  it('applies no restriction for an empty allowlist', () => {
    expect(filterReleasesByMethods([node, compose], [])).toEqual([node, compose]);
  });
});

describe('dispatchRefCandidates', () => {
  // The ref used is the first candidate that is on origin (and has the workflow).
  const pick = (source: string, current: string) =>
    dispatchRefCandidates(source, current, 'main').find((b) => ORIGIN.includes(b));

  it('runs on the release branch of the source branch', () => {
    expect(pick('main', 'qq/asdf')).toBe('release/main');
    expect(pick('feature/wirecut', 'main')).toBe('release/feature/wirecut');
  });

  it('runs on the source branch itself when it has no release branch', () => {
    expect(pick('qq/asdf', 'main')).toBe('qq/asdf');
  });

  it('falls back to the current branch, then the default branch', () => {
    expect(pick('www/qwerty', 'feature/wirecut')).toBe('release/feature/wirecut');
    expect(pick('www/qwerty', 'local/only')).toBe('release/main');
  });

  it('de-dupes, never double-prefixes release/, and skips a detached HEAD', () => {
    expect(dispatchRefCandidates('main', 'release/main', 'main')).toEqual(['release/main', 'main']);
    expect(dispatchRefCandidates('', '', 'main')).toEqual(['release/main', 'main']);
  });
});

describe('isGitflowTag', () => {
  it('accepts {name}/v{semver} and rejects other layouts', () => {
    expect(isGitflowTag('@org/svc/v1.2.3-feature.x.alpha.1')).toBe(true);
    expect(isGitflowTag('v0.4.0-feature.deploy-flow.dev.10/@org/svc')).toBe(false);
    expect(isGitflowTag('v1.2.3')).toBe(false);
    expect(isGitflowTag('@org/svc/vnext')).toBe(false);
  });
});
