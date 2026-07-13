/**
 * GitHub Action entry-point for the integration test runner.
 * Runs github.actions.build across all packages first, then
 * github.actions.test:integration for packages that declare it.
 */

import * as core from '@actions/core';
import { runScripts } from '@cpdevtools/ts-dev-utilities/runner';
import type { RunSummary } from '@cpdevtools/ts-dev-utilities/runner';

async function run(): Promise<void> {
  try {
    const failFast = (process.env.INPUT_FAIL_FAST ?? 'false') === 'true';
    const rawConcurrency = process.env.INPUT_CONCURRENCY ?? '';
    const concurrency = rawConcurrency ? parseInt(rawConcurrency, 10) : undefined;
    const workspaceRoot = process.env.INPUT_WORKSPACE_ROOT ?? process.cwd();

    core.info('🔬 Integration Test Runner');
    core.info(`  Fail-fast:   ${failFast}`);
    core.info(`  Concurrency: ${concurrency ?? 'unlimited'}`);
    core.info(`  Workspace:   ${workspaceRoot}`);

    // Phase 1: build all packages (so services are compiled before tests run)
    core.info('');
    core.info('── Phase 1: Build ──────────────────────────────────');
    const buildSummary = await runScripts({
      scripts: ['github.actions.build'],
      cwd: workspaceRoot,
      failFast: true, // always fail-fast on build errors
      concurrency,
      beforeTask: (project) => core.info(`▶ build ${project.name}`),
      afterTask: (_project, result) => {
        const icon = result.state === 'passed' ? '✅' : '❌';
        core.info(`${icon} build ${result.project} (${(result.durationMs / 1000).toFixed(1)}s)`);
      },
    });

    if (buildSummary.failed.length > 0) {
      await renderSummary('Build', buildSummary);
      core.setFailed(`${buildSummary.failed.length} project(s) failed to build`);
      return;
    }

    // Phase 2: integration tests (only packages that declare the script)
    core.info('');
    core.info('── Phase 2: Integration Tests ──────────────────────');
    const testSummary = await runScripts({
      scripts: ['github.actions.test:integration'],
      cwd: workspaceRoot,
      failFast,
      concurrency,
      beforeTask: (project) => core.info(`▶ ${project.name}`),
      afterTask: (_project, result) => {
        const icon = result.state === 'passed' ? '✅' : '❌';
        core.info(`${icon} ${result.project} (${(result.durationMs / 1000).toFixed(1)}s)`);
        if (result.output?.trim()) {
          for (const line of result.output.trimEnd().split('\n')) {
            core.info(`  ${line}`);
          }
        }
      },
    });

    await renderSummary('Integration Tests', testSummary);

    core.setOutput('projects-passed', testSummary.passed.length);
    core.setOutput('projects-failed', testSummary.failed.length);
    core.setOutput('projects-skipped', testSummary.skipped.length);

    if (testSummary.failed.length > 0) {
      core.setFailed(`${testSummary.failed.length} project(s) failed integration tests`);
    }
  } catch (error) {
    core.setFailed((error as Error).message);
  }
}

async function renderSummary(heading: string, summary: RunSummary): Promise<void> {
  for (const task of summary.failed) {
    const output = task.output
      ? `${task.truncated ? '[Output truncated]\n' : ''}${task.output.trimEnd()}`
      : '(no output)';
    core.error(`${task.project} failed:\n${output}`, { title: `Failed: ${task.project}` });
  }

  await core.summary
    .addHeading(`${heading} Results`, 2)
    .addTable([
      [
        { data: 'Status', header: true },
        { data: 'Count', header: true },
        { data: 'Projects', header: true },
      ],
      ['✅ Passed',    String(summary.passed.length),    summary.passed.map((t) => t.project).join(', ')    || '—'],
      ['❌ Failed',    String(summary.failed.length),    summary.failed.map((t) => t.project).join(', ')    || '—'],
      ['⏭ Skipped',   String(summary.skipped.length),   summary.skipped.map((t) => t.project).join(', ')   || '—'],
      ['🚫 Cancelled', String(summary.cancelled.length), summary.cancelled.map((t) => t.project).join(', ') || '—'],
    ])
    .write();

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
