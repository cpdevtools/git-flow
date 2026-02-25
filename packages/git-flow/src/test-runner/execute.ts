import { execSync } from 'node:child_process';
import type { TestOptions, TestResult } from './types.js';
import type { Project } from '../lib/project.js';
import { getCurrentSHA, recordTestPass } from './changeDetection.js';

/**
 * Execute all applicable test scripts for a single project according to the
 * active mode.  Handles dependency-failure short-circuit, atomic tagging on
 * success, and per-script failure reporting.
 */
export async function executeTest(
  project: Project,
  context: TestOptions,
  failedProjects: Set<string>,
): Promise<TestResult> {
  const startTime = Date.now();

  // --- Dependency-failure short-circuit ---
  const failedDep = project.dependencies.find(dep => failedProjects.has(dep));
  if (failedDep) {
    console.log(`⏭  Skipping ${project.name} (dependency ${failedDep} failed)`);
    return { project, success: false, duration: 0, reason: 'dependency-failed' };
  }

  // --- Determine scripts to run based on mode ---
  const scripts = project.packageJson.scripts ?? {};
  const hasBuild = !!scripts['github.actions.build'];
  const hasTest = !!scripts['github.actions.test'];

  const toRun: Array<{ script: string; tagType: 'build' | 'test' }> = [];
  if (context.mode === 'build' && hasBuild) {
    toRun.push({ script: 'github.actions.build', tagType: 'build' });
  } else if (context.mode === 'test' && hasTest) {
    toRun.push({ script: 'github.actions.test', tagType: 'test' });
  } else if (context.mode === 'test-optional') {
    if (hasBuild) toRun.push({ script: 'github.actions.build', tagType: 'build' });
    if (hasTest) toRun.push({ script: 'github.actions.test', tagType: 'test' });
  }

  if (toRun.length === 0) {
    // Project has no applicable scripts for this mode — skip silently
    return { project, success: true, duration: 0, reason: 'no-scripts' };
  }

  console.log(`\n🧪 Testing ${project.name} [mode: ${context.mode}]...`);

  const env = {
    ...process.env,
    PROJECT_NAME: project.name,
    PROJECT_CWD: project.directory,
  };

  // --- Run scripts sequentially; stop on first failure ---
  for (const { script, tagType } of toRun) {
    try {
      console.log(`   Running: pnpm run ${script}`);
      const output = execSync(`pnpm run ${script}`, {
        cwd: project.directory,
        env,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      console.log(output?.trim() || '');
    } catch (err: any) {
      const duration = Date.now() - startTime;
      const output = ((err.stdout as string) || '') + ((err.stderr as string) || '');
      console.error(`❌ ${project.name} (${duration}ms) — '${script}' failed`);
      if (output.trim()) console.error(output.trim());
      return {
        project,
        success: false,
        duration,
        reason: 'failed',
        error: new Error(output || `Script '${script}' exited with code ${err.status}`),
        output,
      };
    }
  }

  // --- All scripts passed — record tags atomically ---
  // Both tags are only written when ALL scripts pass (atomic for test-optional)
  const sha = await getCurrentSHA(context.workspaceRoot);
  for (const { tagType } of toRun) {
    try {
      await recordTestPass(context.workspaceRoot, project, context.branch, tagType, sha);
    } catch (tagErr: any) {
      // Tag writing failure is non-fatal — warn but continue
      console.warn(`⚠  Failed to record tag for ${project.name} (${tagType}): ${tagErr.message}`);
    }
  }

  const duration = Date.now() - startTime;
  console.log(`✅ ${project.name} (${duration}ms)`);
  return { project, success: true, duration };
}
