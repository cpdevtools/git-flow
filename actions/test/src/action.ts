/**
 * GitHub Action entry-point for the parallel script runner.
 * Maps mode → script list, calls the generic runScripts engine, then renders
 * GitHub annotations, a step summary, and the appropriate exit code.
 */

import * as core from '@actions/core';
import { runScripts } from '@cpdevtools/ts-dev-utilities/runner';
import type { RunSummary } from '@cpdevtools/ts-dev-utilities/runner';

const MODE_SCRIPTS: Record<string, string[]> = {
  build: ['github.actions.build'],
  test: ['github.actions.test'],
  'test-optional': ['github.actions.build', 'github.actions.test'],
};

async function run(): Promise<void> {
  try {
    const rawMode = process.env.INPUT_MODE ?? 'test-optional';
    const mode = rawMode in MODE_SCRIPTS ? rawMode : 'test-optional';
    const scripts = MODE_SCRIPTS[mode];

    const failFast = (process.env.INPUT_FAIL_FAST ?? 'false') === 'true';
    const rawConcurrency = process.env.INPUT_CONCURRENCY ?? '';
    const concurrency = rawConcurrency ? parseInt(rawConcurrency, 10) : undefined;
    const workspaceRoot = process.env.INPUT_WORKSPACE_ROOT ?? process.cwd();

    core.info('🧪 Test Runner');
    core.info(`  Mode:        ${mode}`);
    core.info(`  Scripts:     ${scripts.join(', ')}`);
    core.info(`  Fail-fast:   ${failFast}`);
    core.info(`  Concurrency: ${concurrency ?? 'unlimited'}`);
    core.info(`  Workspace:   ${workspaceRoot}`);

    const summary = await runScripts({
      scripts,
      cwd: workspaceRoot,
      failFast,
      concurrency,
      beforeTask: (project) => {
        core.info(`▶ ${project.name}`);
      },
      afterTask: (_project, result) => {
        const icon = result.state === 'passed' ? '✅' : '❌';
        const label = `${icon} ${result.project} (${(result.durationMs / 1000).toFixed(1)}s)`;
        if (result.output?.trim()) {
          core.startGroup(label);
          process.stdout.write(result.output);
          core.endGroup();
        } else {
          core.info(label);
        }
      },
    });

    await renderSummary(summary);

    core.setOutput('projects-passed', summary.passed.length);
    core.setOutput('projects-failed', summary.failed.length);
    core.setOutput('projects-skipped', summary.skipped.length);

    if (summary.failed.length > 0) {
      core.setFailed(`${summary.failed.length} project(s) failed`);
    }
  } catch (error) {
    core.setFailed((error as Error).message);
  }
}

async function renderSummary(summary: RunSummary): Promise<void> {
  // GitHub Annotations — one error annotation per failed task
  for (const task of summary.failed) {
    const output = task.output
      ? `${task.truncated ? '[Output truncated]\n' : ''}${task.output.trimEnd()}`
      : '(no output)';
    core.error(`${task.project} failed:\n${output}`, { title: `Failed: ${task.project}` });
  }

  // Step Summary table
  await core.summary
    .addHeading('Test Results', 2)
    .addTable([
      [
        { data: 'Status', header: true },
        { data: 'Count', header: true },
        { data: 'Projects', header: true },
      ],
      ['✅ Passed',   String(summary.passed.length),    summary.passed.map((t) => t.project).join(', ')    || '—'],
      ['❌ Failed',   String(summary.failed.length),    summary.failed.map((t) => t.project).join(', ')    || '—'],
      ['⏭ Skipped',  String(summary.skipped.length),   summary.skipped.map((t) => t.project).join(', ')   || '—'],
      ['🚫 Cancelled', String(summary.cancelled.length), summary.cancelled.map((t) => t.project).join(', ') || '—'],
    ])
    .write();

  // Inline failed-task output in summary
  for (const task of summary.failed) {
    if (task.output) {
      await core.summary
        .addHeading(`❌ ${task.project}`, 3)
        .addCodeBlock(
          task.truncated ? `[Output truncated]\n${task.output}` : task.output,
          'text',
        )
        .write();
    }
  }
}

run();
