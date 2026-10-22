/**
 * Publish-release orchestration: the release is fetched once (by id when the
 * PR carries one), the registry push happens before finalize, finalize happens
 * before any git tag is created, and a rerun on an already-published release
 * resumes instead of skipping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseInfo } from '../build-pack/github.js';

const calls: string[] = [];

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
}));

vi.mock('../lib/project.js', () => ({ discoverProjects: vi.fn(async () => []) }));

const okType = {
  getRegistries: () => ['ghcr'],
  getVersion: (_a: unknown, v: string) => v,
  publish: async () => {
    calls.push('registry:publish');
  },
};
const failingType = {
  ...okType,
  publish: async () => {
    throw new Error('push failed');
  },
};
let artifactType = okType;

vi.mock('../artifacts/index.js', () => ({
  loadPlugins: vi.fn(async () => {}),
  providerOf: vi.fn(() => undefined),
  getArtifactType: vi.fn(() => artifactType),
}));

let verified = false;
vi.mock('../publishing/index.js', () => ({
  computeFloatingTags: vi.fn(() => ['next']),
  loadRegistryConfig: vi.fn(async () => ({})),
  getRegistry: vi.fn(() => ({ type: 'docker' })),
  getToken: vi.fn(() => 'tok'),
  isBuildVersion: vi.fn(() => false),
  isGitHubRegistry: vi.fn(() => true),
  verifyPublication: vi.fn(async () => {
    const r = { published: verified };
    verified = true;
    return r;
  }),
}));

vi.mock('../build-pack/github.js', () => ({
  getReleaseTag: vi.fn((name: string, version: string) => `${name}/v${version}`),
  getReleaseUrl: vi.fn(() => 'https://example.test/release'),
  listProjectVersions: vi.fn(async () => ['0.9.0']),
  resolveRelease: vi.fn(),
  extractArtifactMetadataYaml: vi.fn((body: string | null | undefined) => {
    const m = (body ?? '').match(/```yaml\s*\n([\s\S]*?)\n\s*```/);
    return m ? m[1] : null;
  }),
  downloadReleaseAsset: vi.fn(async (_t: string, _o: string, _r: string, id: number) => {
    calls.push(`download:${id}`);
    return Buffer.from('zip');
  }),
  updateDraftReleaseBody: vi.fn(async () => {
    calls.push('body:update');
  }),
  finalizeReleaseById: vi.fn(async (_t: string, _o: string, _r: string, id: number) => {
    calls.push(`finalize:${id}`);
  }),
  createGitTag: vi.fn(async () => {
    calls.push('tags:create');
  }),
  postPRReleaseComment: vi.fn(async () => {}),
  buildReleaseComment: vi.fn(() => 'comment'),
}));

const github = await import('../build-pack/github.js');
const { runPublishRelease } = await import('./orchestrate.js');

const yaml = ['project: "@acme/app"', 'artifacts:', '  - type: docker', '    name: app'].join('\n');

function release(overrides: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return {
    id: 420876320,
    draft: true,
    tag_name: '@acme/app/v1.0.0',
    name: '@acme/app 1.0.0',
    body: `📋 PR\n\n## Artifact Metadata\n\`\`\`yaml\n${yaml}\n\`\`\``,
    html_url: 'https://example.test/untagged-1',
    upload_url: 'https://example.test/upload',
    assets: [{ id: 11, name: 'deploy-swarm.zip', size: 3 }],
    ...overrides,
  };
}

const options = {
  workspaceRoot: '/ws',
  prNumber: 9,
  githubToken: 'token',
  owner: 'acme',
  repo: 'app',
  sha: 'b113dd80a44867f60fc841b7393d2d857f9656dc',
  projects: [
    {
      name: '@acme/app',
      version: '1.0.0',
      releaseTag: '@acme/app/v1.0.0',
      prerelease: false,
      placeholder: '0.0.0-MAIN',
      releaseId: 420876320,
    },
  ],
};

describe('runPublishRelease', () => {
  beforeEach(() => {
    calls.length = 0;
    verified = false;
    artifactType = okType;
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('fetches the release by the recorded id and never scans the list', async () => {
    vi.mocked(github.resolveRelease).mockResolvedValue(release());

    const result = await runPublishRelease(options);

    expect(result.published).toEqual(['@acme/app']);
    expect(github.resolveRelease).toHaveBeenCalledTimes(1);
    expect(github.resolveRelease).toHaveBeenCalledWith('token', 'acme', 'app', {
      tag: '@acme/app/v1.0.0',
      releaseId: 420876320,
    });
  });

  it('pushes registries, updates the body, finalizes, then creates the git tags', async () => {
    vi.mocked(github.resolveRelease).mockResolvedValue(release());

    await runPublishRelease(options);

    expect(calls).toEqual([
      'download:11',
      'registry:publish',
      'body:update',
      'finalize:420876320',
      'tags:create',
    ]);
    expect(github.finalizeReleaseById).toHaveBeenCalledWith(
      'token',
      'acme',
      'app',
      420876320,
      '@acme/app/v1.0.0',
      options.sha,
      false,
    );
  });

  it('passes no id for a PR built before ids were recorded (list-scan fallback)', async () => {
    vi.mocked(github.resolveRelease).mockResolvedValue(release());
    const legacy = { ...options, projects: [{ ...options.projects[0], releaseId: undefined }] };

    await runPublishRelease(legacy);

    expect(github.resolveRelease).toHaveBeenCalledWith('token', 'acme', 'app', {
      tag: '@acme/app/v1.0.0',
      releaseId: undefined,
    });
    expect(calls).toContain('finalize:420876320');
  });

  it('resumes an already-published release: registries, body and tags, but no finalize', async () => {
    vi.mocked(github.resolveRelease).mockResolvedValue(release({ draft: false }));

    const result = await runPublishRelease(options);

    expect(result.published).toEqual(['@acme/app']);
    expect(calls).toEqual(['download:11', 'registry:publish', 'body:update', 'tags:create']);
    expect(github.finalizeReleaseById).not.toHaveBeenCalled();
  });

  it('fails before touching registries or tags when the release cannot be found', async () => {
    vi.mocked(github.resolveRelease).mockResolvedValue(null);

    await expect(runPublishRelease(options)).rejects.toThrow(
      /Release not found for @acme\/app\/v1\.0\.0 \(id 420876320 returned 404\)/,
    );
    expect(calls).toEqual([]);
  });

  it('fails when the release body carries no artifact metadata', async () => {
    vi.mocked(github.resolveRelease).mockResolvedValue(release({ body: 'nothing here' }));

    await expect(runPublishRelease(options)).rejects.toThrow(/No artifact metadata found/);
    expect(calls).toEqual([]);
  });

  it('leaves the draft untouched when a registry push fails', async () => {
    vi.mocked(github.resolveRelease).mockResolvedValue(release());
    artifactType = failingType;

    await expect(runPublishRelease(options)).rejects.toThrow(/push failed/);
    expect(github.finalizeReleaseById).not.toHaveBeenCalled();
    expect(github.createGitTag).not.toHaveBeenCalled();
  });
});
