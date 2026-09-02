import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../lib/project';
import type { BuildPackContext } from './types.js';

type MockState = 'passed' | 'no-script' | 'failed' | 'skipped';

/** Per-test scheduler outcome, keyed by project name. Defaults to 'passed'. */
const schedulerStates = new Map<string, MockState>();

/**
 * Newer ts-dev-utilities calls the task hooks for no-script tasks as well.
 * Toggles between that and the older scheduler, which did not — build-pack has
 * to produce the same release either way.
 */
let schedulerFiresNoScriptHooks = false;

vi.mock('@cpdevtools/ts-dev-utilities/runner', () => ({
  // Minimal stand-in for the real scheduler: drives beforeTask/afterTask exactly
  // where the real one does — i.e. only for tasks that actually ran a script.
  runScripts: vi.fn(async (options: any) => {
    const projects = await options._discover({});
    const summary: any = { passed: [], failed: [], skipped: [], cancelled: [], noScript: [] };

    for (const project of projects) {
      const state = schedulerStates.get(project.name) ?? 'passed';
      const result = {
        project: project.name,
        projectDir: project.directory,
        scripts: options.scripts,
        state,
        durationMs: 0,
      };

      if (state === 'passed') {
        await options.beforeTask?.(project);
        try {
          await options.afterTask?.(project, result);
          summary.passed.push(result);
        } catch (err) {
          summary.failed.push({ ...result, state: 'failed', output: (err as Error).message });
        }
      } else if (state === 'no-script') {
        if (schedulerFiresNoScriptHooks) {
          await options.beforeTask?.(project);
          try {
            await options.afterTask?.(project, result);
            summary.noScript.push(result);
          } catch (err) {
            summary.failed.push({ ...result, state: 'failed', output: (err as Error).message });
          }
        } else {
          summary.noScript.push(result);
        }
      } else if (state === 'failed') {
        summary.failed.push({ ...result, output: 'build blew up' });
      } else {
        summary.skipped.push(result);
      }
    }

    return summary;
  }),
}));

vi.mock('../artifacts/index.js', () => ({ loadPlugins: vi.fn(async () => {}) }));

vi.mock('../lib/project', () => ({ discoverProjects: vi.fn(async () => discovered) }));

vi.mock('./github.js', () => ({
  deleteDraftRelease: vi.fn(async () => {}),
  findDraftReleaseByTag: vi.fn(async () => null),
  getReleaseTag: vi.fn((name: string, version: string) => `${name}/v${version}`),
  isArtifactUploaded: vi.fn(async () => false),
}));

vi.mock('./execute.js', () => ({
  applyVersion: vi.fn(async () => {}),
  executePack: vi.fn(async (project: any) => ({ project: project.name, success: true })),
  executeUpload: vi.fn(async (project: any) => ({
    project: project.name,
    success: true,
    releaseUrl: `https://example.test/${project.name}`,
  })),
}));

const { applyVersion, executePack, executeUpload } = await import('./execute.js');
const { runBuildPack } = await import('./orchestrate.js');

let discovered: Project[] = [];

function project(name: string, scripts: Record<string, string>): Project {
  return {
    name,
    directory: `/ws/${name.replace(/[@/]/g, '-')}`,
    packageJsonPath: `/ws/${name.replace(/[@/]/g, '-')}/package.json`,
    packageJson: { name, version: '0.0.0-MAIN', scripts },
  } as unknown as Project;
}

function prBody(...projects: { name: string; version: string }[]): string {
  const entries = projects
    .map((p) => `    - name: ${p.name}\n      version: ${p.version}\n      prerelease: false`)
    .join('\n');
  return ['```yaml', 'MAIN:', '  projects:', entries, '```'].join('\n');
}

const context: BuildPackContext = {
  workspaceRoot: '/ws',
  githubToken: 'token',
  prNumber: 7,
  sha: 'dcade15dcade15dcade15dcade15dcade15dcade1',
  runNumber: 1,
} as BuildPackContext;

describe('runBuildPack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    schedulerStates.clear();
    schedulerFiresNoScriptHooks = false;
    delete process.env.GITHUB_REPOSITORY;
  });

  it('packs and uploads a release project that has no github.actions.build', async () => {
    discovered = [project('@idealsupply/swarmpit', { 'github.actions.pack': 'gitflow pack' })];
    schedulerStates.set('@idealsupply/swarmpit', 'no-script');

    const result = await runBuildPack(
      context,
      prBody({
        name: '@idealsupply/swarmpit',
        version: '2.0.1-alpha.0',
      }),
    );

    expect(applyVersion).toHaveBeenCalledWith('/ws/-idealsupply-swarmpit', '2.0.1-alpha.0');
    expect(executePack).toHaveBeenCalledTimes(1);
    expect(executeUpload).toHaveBeenCalledTimes(1);
    expect(result.packed).toEqual(['@idealsupply/swarmpit']);
    expect(result.uploaded).toEqual(['@idealsupply/swarmpit']);
    expect(result.releases).toEqual([
      {
        name: '@idealsupply/swarmpit',
        version: '2.0.1-alpha.0',
        url: 'https://example.test/@idealsupply/swarmpit',
      },
    ]);
    expect(result.failed).toEqual([]);
  });

  it('packs a build-less release project exactly once when the scheduler fires its hooks', async () => {
    schedulerFiresNoScriptHooks = true;
    discovered = [project('@idealsupply/swarmpit', { 'github.actions.pack': 'gitflow pack' })];
    schedulerStates.set('@idealsupply/swarmpit', 'no-script');

    const result = await runBuildPack(
      context,
      prBody({ name: '@idealsupply/swarmpit', version: '2.0.1-alpha.0' }),
    );

    expect(executePack).toHaveBeenCalledTimes(1);
    expect(executeUpload).toHaveBeenCalledTimes(1);
    expect(result.packed).toEqual(['@idealsupply/swarmpit']);
    expect(result.failed).toEqual([]);
  });

  it('still packs release projects that do have a build script', async () => {
    discovered = [
      project('@scope/app', {
        'github.actions.build': 'tsc',
        'github.actions.pack': 'gitflow pack',
      }),
    ];

    const result = await runBuildPack(context, prBody({ name: '@scope/app', version: '1.2.3' }));

    expect(executePack).toHaveBeenCalledTimes(1);
    expect(result.packed).toEqual(['@scope/app']);
    expect(result.failed).toEqual([]);
  });

  it('reports a failure when packing a build-less release project fails', async () => {
    discovered = [project('@scope/svc', { 'github.actions.pack': 'gitflow pack' })];
    schedulerStates.set('@scope/svc', 'no-script');
    vi.mocked(executePack).mockResolvedValueOnce({
      project: '@scope/svc',
      success: false,
      error: 'deploy bundle render failed',
    });

    const result = await runBuildPack(context, prBody({ name: '@scope/svc', version: '1.0.0' }));

    expect(executeUpload).not.toHaveBeenCalled();
    expect(result.packed).toEqual([]);
    expect(result.failed).toEqual([
      { project: '@scope/svc', success: false, error: 'deploy bundle render failed' },
    ]);
  });

  it('fails the run when a release project never produced an artifact', async () => {
    discovered = [project('@scope/svc', { 'github.actions.pack': 'gitflow pack' })];
    schedulerStates.set('@scope/svc', 'skipped');

    const result = await runBuildPack(context, prBody({ name: '@scope/svc', version: '1.0.0' }));

    expect(result.packed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].project).toBe('@scope/svc');
    expect(result.failed[0].error).toMatch(/never packed/);
  });

  it('does not pack build-less release projects when another project failed', async () => {
    discovered = [
      project('@scope/lib', { 'github.actions.build': 'tsc', 'github.actions.pack': 'p' }),
      project('@scope/svc', { 'github.actions.pack': 'gitflow pack' }),
    ];
    schedulerStates.set('@scope/lib', 'failed');
    schedulerStates.set('@scope/svc', 'no-script');

    const result = await runBuildPack(
      context,
      prBody({ name: '@scope/lib', version: '1.0.0' }, { name: '@scope/svc', version: '1.0.0' }),
    );

    expect(executePack).not.toHaveBeenCalled();
    expect(result.failed.map((f) => f.project).sort()).toEqual(['@scope/lib', '@scope/svc']);
  });
});
