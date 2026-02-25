/**
 * GitHub Action entry-point for Phase 4 Test orchestration.
 */

import * as core from '@actions/core';
import { runTest } from '@cpdevtools/git-flow/test-runner';

async function run(): Promise<void> {
  try {
    // Inputs arrive as environment variables (set by action.yml).
    const branch = process.env.GITHUB_REF?.replace('refs/heads/', '') ?? '';
    const rawMode = process.env.INPUT_MODE ?? 'test-optional';
    const mode = (['build', 'test', 'test-optional'] as const).includes(
      rawMode as 'build' | 'test' | 'test-optional',
    )
      ? (rawMode as 'build' | 'test' | 'test-optional')
      : 'test-optional';

    const rerunAll = (process.env.INPUT_RERUN_ALL ?? 'false') === 'true';
    const skipUnchanged =
      !rerunAll && (process.env.INPUT_SKIP_UNCHANGED ?? 'true') === 'true';
    const token = process.env.INPUT_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
    const workspaceRoot = process.env.INPUT_WORKSPACE_ROOT ?? process.cwd();

    if (!branch) {
      throw new Error('GITHUB_REF is not set — cannot determine branch name');
    }
    if (!token) {
      throw new Error('GITHUB_TOKEN is not set — required for pushing pass tags');
    }

    core.info(`🧪 Test Runner`);
    core.info(`  Branch:          ${branch}`);
    core.info(`  Mode:            ${mode}`);
    core.info(`  Rerun All:       ${rerunAll}`);
    core.info(`  Skip Unchanged:  ${skipUnchanged}`);
    core.info(`  Workspace:       ${workspaceRoot}`);

    const result = await runTest({
      workspaceRoot,
      branch,
      mode,
      skipUnchanged,
      rerunAll,
      token,
    });

    core.setOutput('projects-passed', result.passed.length);
    core.setOutput('projects-failed', result.failed.length);
    core.setOutput('projects-skipped', result.skipped.length);
    core.setOutput('projects-unchanged', result.unchanged.length);

    if (result.failed.length > 0) {
      core.setFailed(`${result.failed.length} project(s) failed`);
    }
  } catch (error) {
    core.setFailed((error as Error).message);
  }
}

run();
