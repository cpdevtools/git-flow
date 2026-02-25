import type { TestOptions, TestResult, TestSummary } from './types.js';
import type { Project } from '../lib/project.js';
import { discoverProjects, buildDependencyGraph } from '../lib/project.js';
import { hasProjectChanged, getTagTypesForMode } from './changeDetection.js';
import { executeTest } from './execute.js';

// @actions/core is optional — only available inside a GitHub Actions runner.
// We import it dynamically to avoid breaking local usage.
async function getCoreOrNull() {
  try {
    return await import('@actions/core');
  } catch {
    return null;
  }
}

/**
 * Main orchestration entry-point.
 * Discovers relevant projects, filters unchanged ones, then executes them in
 * topological batches with failure-aware dependency tracking.
 */
export async function runTest(options: TestOptions): Promise<TestSummary> {
  const { rerunAll, skipUnchanged, mode, workspaceRoot, branch } = options;

  // ------------------------------------------------------------------
  // 1. Discover projects relevant to this mode
  // ------------------------------------------------------------------
  console.log(`\n📦 Discovering projects...`);
  const allProjects = await discoverProjects(workspaceRoot);

  const relevant = allProjects.filter(p => {
    const scripts = p.packageJson.scripts ?? {};
    const hasBuild = !!scripts['github.actions.build'];
    const hasTest = !!scripts['github.actions.test'];
    if (mode === 'build') return hasBuild;
    if (mode === 'test') return hasTest;
    return hasBuild || hasTest; // test-optional: include if either exists
  });

  console.log(`Found ${relevant.length} project(s) relevant to mode '${mode}'`);

  if (relevant.length === 0) {
    return { passed: [], failed: [], skipped: [], unchanged: [] };
  }

  // ------------------------------------------------------------------
  // 2. Change detection (skipped when rerunAll is set)
  // ------------------------------------------------------------------
  const unchanged: TestResult[] = [];
  let projectsToRun: Project[] = relevant;

  if (rerunAll) {
    console.log(`\nRerun All: bypassing change detection — running all ${relevant.length} project(s)`);
  } else if (skipUnchanged) {
    console.log(`\n🔍 Detecting changes...`);
    const tagTypes = getTagTypesForMode(mode);
    const changed: Project[] = [];

    for (const project of relevant) {
      // A project is considered unchanged only when ALL relevant tags exist
      // and none of its files have changed since the tagged SHA.
      const changedFlags = await Promise.all(
        tagTypes.map(tagType => hasProjectChanged({ workspaceRoot, project, branch, tagType })),
      );
      const isChanged = changedFlags.some(Boolean);

      if (isChanged) {
        changed.push(project);
      } else {
        console.log(`⏩ ${project.name} (unchanged)`);
        unchanged.push({ project, success: true, duration: 0, reason: 'unchanged' });
      }
    }

    console.log(`Changed: ${changed.length} | Unchanged: ${unchanged.length}`);
    projectsToRun = changed;
  }

  if (projectsToRun.length === 0) {
    const summary: TestSummary = { passed: [], failed: [], skipped: [], unchanged };
    await generateSummary(summary, options);
    return summary;
  }

  // ------------------------------------------------------------------
  // 3. Build dependency graph → topological batches
  // ------------------------------------------------------------------
  const graph = buildDependencyGraph(projectsToRun);
  const batches = graph.getTopologicalBatches();

  // ------------------------------------------------------------------
  // 4. Execute batches with failure tracking
  // ------------------------------------------------------------------
  const failedProjects = new Set<string>();
  const passed: TestResult[] = [];
  const failed: TestResult[] = [];
  const skipped: TestResult[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    // Split batch into runnable + dep-skipped
    const runnable = batch.filter(p => !failedProjects.has(p.name));
    const depSkipped = batch.filter(p => failedProjects.has(p.name));

    for (const p of depSkipped) {
      console.log(`⏭  Skipping ${p.name} (dependency failed)`);
      skipped.push({ project: p, success: false, duration: 0, reason: 'dependency-failed' });
    }

    if (runnable.length === 0) continue;

    console.log(`\n📦 Batch ${i + 1}/${batches.length}: ${runnable.length} project(s)`);

    // Run runnable projects in parallel within the batch
    const batchResults = await Promise.allSettled(
      runnable.map(p => executeTest(p, options, failedProjects)),
    );

    for (const settled of batchResults) {
      if (settled.status === 'rejected') {
        // Unexpected throw — treat as unknown failure
        console.error(`Unexpected error:`, settled.reason);
        continue;
      }

      const result = settled.value;

      if (result.reason === 'dependency-failed') {
        skipped.push(result);
      } else if (result.reason === 'unchanged') {
        unchanged.push(result);
      } else if (result.reason === 'no-scripts') {
        // silently ignore — project had no applicable scripts
      } else if (result.success) {
        passed.push(result);
      } else {
        failed.push(result);
        failedProjects.add(result.project.name);
      }
    }
  }

  // ------------------------------------------------------------------
  // 5. Summary
  // ------------------------------------------------------------------
  const summary: TestSummary = { passed, failed, skipped, unchanged };
  await generateSummary(summary, options);
  return summary;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function generateSummary(
  results: TestSummary,
  options: TestOptions,
): Promise<void> {
  const { passed, failed, skipped, unchanged } = results;
  const total = passed.length + failed.length + skipped.length + unchanged.length;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Test Results  [mode: ${options.mode}]`);
  console.log(`  ✅ Passed:    ${passed.length}`);
  console.log(`  ❌ Failed:    ${failed.length}`);
  console.log(`  ⏭  Skipped:   ${skipped.length}  (dependency failure)`);
  console.log(`  ⏩ Unchanged: ${unchanged.length}  (change detection)`);
  console.log(`  ─────────────────────`);
  console.log(`  Total:       ${total}`);

  // GitHub Actions step summary (non-fatal if not in runner)
  const core = await getCoreOrNull();
  if (!core) return;

  try {
    const lines: string[] = [
      '## 🧪 Test Results',
      '',
      `> Mode: \`${options.mode}\` | Branch: \`${options.branch}\``,
      '',
      '| Status | Count |',
      '|--------|------:|',
      `| ✅ Passed | ${passed.length} |`,
      `| ❌ Failed | ${failed.length} |`,
      `| ⏭ Skipped (dep failed) | ${skipped.length} |`,
      `| ⏩ Unchanged (skipped) | ${unchanged.length} |`,
      '',
    ];

    if (failed.length > 0) {
      lines.push('### ❌ Failed Projects', '');
      for (const r of failed) {
        lines.push(`- **${r.project.name}** (${r.duration}ms)`);
        if (r.output?.trim()) {
          lines.push('  ```', r.output.trim().slice(0, 2000), '  ```', '');
        }
      }
    }

    if (skipped.length > 0) {
      lines.push('### ⏭ Skipped Projects (dependency failure)', '');
      for (const r of skipped) {
        const failedDep = r.project.dependencies.find(d => true);
        lines.push(`- **${r.project.name}**${failedDep ? ` → depends on \`${failedDep}\`` : ''}`);
      }
      lines.push('');
    }

    await core.summary.addRaw(lines.join('\n')).write();
  } catch {
    // Summary writing is non-critical
  }
}
