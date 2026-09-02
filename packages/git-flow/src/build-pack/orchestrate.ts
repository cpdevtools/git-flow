/**
 * Main orchestration for Phase 2 Build & Pack workflow
 */

import type { Project as SchedulerProject } from '@cpdevtools/ts-dev-utilities/project';
import { runScripts } from '@cpdevtools/ts-dev-utilities/runner';
import { join } from 'path';
import { loadPlugins } from '../artifacts/index.js';
import type { Project } from '../lib/project';
import { discoverProjects } from '../lib/project';
import { applyVersion, executePack, executeUpload } from './execute.js';
import { ARTIFACT_OUTPUT_DIR } from './generate-artifact.js';
import {
  deleteDraftRelease,
  findDraftReleaseByTag,
  getReleaseTag,
  isArtifactUploaded,
} from './github.js';
import { extractPRMetadata } from './options.js';
import type {
  BuildPackContext,
  BuildPackRelease,
  BuildPackResult,
  ExecutionResult,
  PRMetadata,
  ProjectConfig,
} from './types.js';

/**
 * Main entry point for build & pack workflow
 * @param context - Workflow context
 * @param prBody - Pull request body containing metadata and options
 */
export async function runBuildPack(
  context: BuildPackContext,
  prBody: string,
): Promise<BuildPackResult> {
  console.log('🚀 Starting Phase 2: Build & Pack\n');

  // Registration has to happen before anything dispatches an artifact, and once
  // per process rather than per config load — the deploy paths never read
  // release-artifacts.yml at all.
  await loadPlugins({ workspaceRoot: context.workspaceRoot });

  // Extract metadata from PR body
  const metadata = extractPRMetadata(prBody);
  const allProjects = Object.values(metadata.projectsByPlaceholder).flat();
  console.log(`📋 Processing ${allProjects.length} projects from PR #${context.prNumber}`);
  console.log(`   Run: ${context.runNumber}`);
  console.log(`   SHA: ${context.sha.substring(0, 7)}`);

  // Display projects grouped by placeholder
  for (const [placeholder, projects] of Object.entries(metadata.projectsByPlaceholder)) {
    console.log(`   ${placeholder}: ${projects.map((p) => p.name).join(', ')}`);
  }

  // Handle Force Rebuild if enabled
  if (metadata.forceRebuild) {
    console.log('\n🔄 Force Rebuild enabled - deleting existing draft releases...');
    const owner = process.env.GITHUB_REPOSITORY_OWNER || 'cpdevtools';
    const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'unknown';

    for (const project of allProjects) {
      await deleteDraftRelease(context.githubToken, owner, repo, project.name, project.version);
    }
    console.log('   ✓ Draft releases deleted');
  }
  console.log();

  // Discover all workspace projects
  console.log('🔍 Discovering workspace projects...');
  const discoveredProjects = await discoverProjects(context.workspaceRoot);
  console.log(`   Found ${discoveredProjects.length} projects:`);
  discoveredProjects.forEach((p) => console.log(`     - ${p.name}`));
  console.log('');

  // Build project configurations from metadata (projects to pack/publish)
  const projectsToRelease = buildProjectConfigs(metadata, discoveredProjects, context);

  // Check which projects already have artifacts uploaded (resumability)
  console.log('🔍 Checking for existing artifacts...');
  const projectsToSkip = await findCompletedProjects(projectsToRelease, context);

  if (projectsToSkip.length > 0) {
    console.log(`   ✓ Found ${projectsToSkip.length} project(s) with artifacts already uploaded:`);
    for (const project of projectsToSkip) {
      console.log(`     • ${project.name} v${project.version}`);
    }
  } else {
    console.log(`   No existing artifacts found`);
  }
  console.log();

  // Filter out completed projects
  const projectsToProcess = projectsToRelease.filter(
    (p) => !projectsToSkip.find((skip) => skip.name === p.name),
  );

  if (projectsToProcess.length === 0) {
    console.log('✅ All projects already have artifacts uploaded. Nothing to do.');
    return {
      built: [],
      packed: [],
      uploaded: [],
      skipped: projectsToSkip.map((p) => p.name),
      failed: [],
      cancelled: [],
      releases: [],
    };
  }

  console.log(
    `📦 Projects remaining to release: ${projectsToProcess.map((p) => p.name).join(', ')}\n`,
  );

  // Find all dependencies that need to be built (but not necessarily packed)
  const allProjectsToProcess = findAllDependencies(projectsToProcess, discoveredProjects, context);

  const dependenciesOnly = allProjectsToProcess.filter(
    (p) => !projectsToProcess.find((r) => r.name === p.name),
  );

  if (dependenciesOnly.length > 0) {
    console.log(
      `🔧 Additional dependencies to build: ${dependenciesOnly.map((p) => p.name).join(', ')}`,
    );
  } else {
    console.log(`🔧 No additional dependencies needed`);
  }
  console.log();

  // Add allProjects to context for workspace dependency resolution
  const contextWithProjects: BuildPackContext = {
    ...context,
    allProjects: allProjectsToProcess,
  };

  // Display execution plan
  displayExecutionPlan(allProjectsToProcess, projectsToProcess);

  // Build lookup structures for hooks
  const projectConfigMap = new Map<string, ProjectConfig>(
    allProjectsToProcess.map((p) => [p.name, p]),
  );
  const releaseSet = new Set<string>(projectsToProcess.map((p) => p.name));
  const releaseUrlMap = new Map<string, string>(); // project name → html_url
  const packedSet = new Set<string>(); // release projects that produced an artifact

  /**
   * Pack + upload a single release project. Driven from two places: the build
   * task's `afterTask` hook, and the post-scheduler pass that catches release
   * projects which never ran a build task at all.
   */
  const packAndUpload = async (name: string): Promise<void> => {
    const config = projectConfigMap.get(name)!;
    const packResult = await executePack(config, contextWithProjects);
    if (!packResult.success) {
      throw new Error(packResult.error || 'Pack failed');
    }
    if (!context.skipUpload) {
      const uploadResult = await executeUpload(config, contextWithProjects);
      if (!uploadResult.success) {
        throw new Error(uploadResult.error || 'Upload failed');
      }
      if (uploadResult.releaseUrl) {
        releaseUrlMap.set(name, uploadResult.releaseUrl);
      }
    }
    packedSet.add(name);
  };

  // Map ProjectConfig[] to the scheduler's Project type so the scheduler can
  // build a real dependency graph from packageJson.dependencies/devDependencies.
  const schedulerProjects: SchedulerProject[] = allProjectsToProcess.map((config) => ({
    packageJsonPath: join(config.cwd, 'package.json'),
    directory: config.cwd,
    packageJson: config.packageJson,
    name: config.name,
  }));

  // Run builds via scheduler (handles dependency ordering, concurrency, fail-fast)
  const summary = await runScripts({
    scripts: ['github.actions.build'],
    failFast: true,
    env: {
      ARTIFACT_OUTPUT_DIR,
      GITHUB_SHA: context.sha,
    },
    onOutput: (_project, chunk) => process.stdout.write(chunk),
    beforeTask: async (project) => {
      const config = projectConfigMap.get(project.name)!;
      console.log(`  📝 ${project.name}: Applying version ${config.version}...`);
      await applyVersion(config.cwd, config.version);
      return { PROJECT_VERSION: config.version };
    },
    // Fires for `no-script` too: release participation hangs on
    // `github.actions.pack`, so a project with nothing to build still has to be
    // packed. ts-dev-utilities 1.1.7 and older never call the hook for those —
    // the post-scheduler pass below is the fallback that covers them there.
    afterTask: async (project, result) => {
      if (result.state !== 'passed' && result.state !== 'no-script') return;
      if (!releaseSet.has(project.name)) {
        const outcome = result.state === 'no-script' ? 'Nothing to build' : 'Build completed';
        console.log(`✓ ${project.name}: ${outcome} (dependency only, skipping pack/upload)`);
        return;
      }
      if (result.state === 'no-script') {
        console.log(`📦 ${project.name}: no "github.actions.build" script - packing anyway`);
      }
      await packAndUpload(project.name);
    },
    _discover: async () => schedulerProjects,
  });

  // Fallback for ts-dev-utilities 1.1.7 and older, whose scheduler fires
  // `afterTask` only for tasks that ran a script. There, a release project without
  // a `github.actions.build` ends as `no-script` and would silently drop out of
  // the release with exit 0 — which is every `docker-service` project, whose
  // only product is a deploy bundle and which has nothing to build by
  // definition. Pack/upload whatever the hook did not; the scheduler has
  // finished, so dependency ordering is satisfied either way.
  const noScriptFailures: ExecutionResult[] = [];
  const noScriptReleases = summary.noScript.filter(
    (t) => releaseSet.has(t.project) && !packedSet.has(t.project),
  );

  if (noScriptReleases.length > 0 && summary.failed.length === 0) {
    for (const task of noScriptReleases) {
      const config = projectConfigMap.get(task.project)!;
      console.log(
        `\n📦 ${task.project}: no "github.actions.build" script - packing without a build step`,
      );
      try {
        console.log(`  📝 ${task.project}: Applying version ${config.version}...`);
        await applyVersion(config.cwd, config.version);
        await packAndUpload(task.project);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`✗ ${task.project}: ${message}`);
        noScriptFailures.push({ project: task.project, success: false, error: message });
      }
    }
  }

  // Map RunSummary back to the legacy result shapes
  const builtProjects = [
    ...summary.passed.map((t) => t.project),
    ...summary.noScript.map((t) => t.project),
  ];
  const packedProjects = [...packedSet];
  const uploadedProjects = context.skipUpload ? [] : [...packedProjects];

  const releases: BuildPackRelease[] = packedProjects
    .filter((name) => releaseUrlMap.has(name))
    .map((name) => {
      const config = projectConfigMap.get(name)!;
      return { name, version: config.version, url: releaseUrlMap.get(name)! };
    });

  // Only genuine failures go in `failed`; siblings/dependents the scheduler
  // cancelled via fail-fast are reported separately so one real error does not
  // read as N failures.
  const failedResults: ExecutionResult[] = [
    ...summary.failed.map((t) => ({
      project: t.project,
      success: false,
      error: t.output || 'Build failed',
    })),
    ...noScriptFailures,
  ];
  const cancelledProjects = summary.cancelled.map((t) => t.project);

  // Nothing in the release set may leave this job without an artifact. Without
  // this, `publish-release` is the first thing to notice — after the release PR
  // has already merged.
  const reportedProjects = new Set<string>([
    ...failedResults.map((f) => f.project),
    ...cancelledProjects,
  ]);
  for (const name of releaseSet) {
    if (packedSet.has(name) || reportedProjects.has(name)) continue;
    failedResults.push({
      project: name,
      success: false,
      error:
        `Release project ${name} was never packed. It takes part in the release ` +
        `(it defines "github.actions.pack") but no artifact was produced for it.`,
    });
  }

  // A project that built but then failed to pack (or never packed at all) must
  // not be counted twice — once as a success and once as a failure.
  const totalSuccess = builtProjects.filter(
    (name) => !failedResults.some((f) => f.project === name),
  ).length;

  // Final summary
  console.log(`\n${'='.repeat(80)}`);
  if (failedResults.length === 0 && cancelledProjects.length === 0) {
    console.log(`✅ Phase 2 Complete: ${totalSuccess} projects succeeded`);
  } else {
    const cancelledNote =
      cancelledProjects.length > 0 ? `, ${cancelledProjects.length} cancelled (fail-fast)` : '';
    console.log(
      `⚠️  Phase 2 Completed with errors: ${totalSuccess} succeeded, ${failedResults.length} failed${cancelledNote}`,
    );
  }
  console.log(`${'='.repeat(80)}\n`);

  return {
    built: builtProjects,
    packed: packedProjects,
    uploaded: uploadedProjects,
    skipped: projectsToSkip.map((p) => p.name),
    failed: failedResults,
    cancelled: cancelledProjects,
    releases,
  };
}

/**
 * Build project configurations from PR metadata
 */
function buildProjectConfigs(
  metadata: PRMetadata,
  discoveredProjects: Project[],
  context: BuildPackContext,
): ProjectConfig[] {
  const configs: ProjectConfig[] = [];
  const allProjects = Object.values(metadata.projectsByPlaceholder).flat();

  for (const prProject of allProjects) {
    console.log(`   Looking for project: "${prProject.name}"`);
    // Find matching discovered project
    const discovered = discoveredProjects.find((p) => p.name === prProject.name);
    console.log(`   Found match: ${discovered ? 'YES' : 'NO'}`);

    if (!discovered) {
      console.log(
        `   Available projects: ${discoveredProjects.map((p) => `"${p.name}"`).join(', ')}`,
      );
      throw new Error(`Project ${prProject.name} from PR metadata not found in workspace`);
    }

    configs.push({
      ...discovered,
      name: prProject.name,
      cwd: discovered.directory, // Use the discovered project's actual directory
      version: prProject.version,
      prerelease: prProject.prerelease,
      placeholder: prProject.placeholder,
    });
  }

  return configs;
}

/**
 * Find projects that already have their artifact manifests uploaded
 * Enables resumability - skip projects that completed successfully in previous runs
 */
async function findCompletedProjects(
  projectsToRelease: ProjectConfig[],
  context: BuildPackContext,
): Promise<ProjectConfig[]> {
  const completed: ProjectConfig[] = [];
  const owner = process.env.GITHUB_REPOSITORY_OWNER || 'cpdevtools';
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || '';

  if (!repo) {
    console.log('  ⚠️  GITHUB_REPOSITORY not set, skipping resumability check');
    return completed;
  }

  console.log('  📋 Checking for completed projects in draft releases...');

  for (const project of projectsToRelease) {
    const tag = getReleaseTag(project.name, project.version);

    try {
      const release = await findDraftReleaseByTag(context.githubToken, owner, repo, tag);

      if (release) {
        const artifactFileName = `${project.name}.artifact.yml`;
        const hasArtifact = await isArtifactUploaded(
          context.githubToken,
          owner,
          repo,
          release.id,
          artifactFileName,
        );

        if (hasArtifact) {
          console.log(`    ✅ ${project.name} already completed (found ${artifactFileName})`);
          completed.push(project);
        } else {
          console.log(`    ⏭️  ${project.name} has draft release but missing artifact`);
        }
      } else {
        console.log(`    🆕 ${project.name} - no existing draft release`);
      }
    } catch (error) {
      // Log but don't fail - proceed as if not completed
      console.log(
        `    ⚠️  Error checking ${project.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (completed.length > 0) {
    console.log(`  ✨ Found ${completed.length} completed project(s), will skip`);
  }

  return completed;
}

/**
 * Find all dependencies that need to be built
 * Recursively includes all workspace dependencies of projects to release
 */
function findAllDependencies(
  projectsToRelease: ProjectConfig[],
  discoveredProjects: Project[],
  context: BuildPackContext,
): ProjectConfig[] {
  const allProjects = new Map<string, ProjectConfig>();
  const toProcess = [...projectsToRelease];

  // Add all release projects first
  for (const project of projectsToRelease) {
    allProjects.set(project.name, project);
  }

  // Recursively find dependencies
  while (toProcess.length > 0) {
    const current = toProcess.shift()!;
    const deps = {
      ...current.packageJson.dependencies,
      ...current.packageJson.devDependencies,
    };

    for (const depName of Object.keys(deps || {})) {
      // Skip if already processed
      if (allProjects.has(depName)) {
        continue;
      }

      // Find in discovered projects
      const depProject = discoveredProjects.find((p) => p.name === depName);
      if (depProject) {
        // Create a config for this dependency (not for release, just for build)
        const depConfig: ProjectConfig = {
          ...depProject,
          name: depProject.name,
          cwd: depProject.directory,
          version: depProject.packageJson.version || '0.0.0',
          prerelease: false,
          placeholder: depProject.packageJson.version || '0.0.0',
        };

        allProjects.set(depName, depConfig);
        toProcess.push(depConfig);
      }
    }
  }

  return Array.from(allProjects.values());
}

/**
 * Display execution plan
 */
function displayExecutionPlan(
  allProjects: ProjectConfig[],
  projectsToRelease: ProjectConfig[],
): void {
  console.log('📋 Execution Plan:');
  console.log('─'.repeat(80));

  for (const config of allProjects) {
    const isRelease = projectsToRelease.find((p) => p.name === config.name);
    const label = isRelease ? 'RELEASE' : 'build-only';
    console.log(`  • ${config.name} v${config.version} [${label}]`);
  }

  console.log();
}

/**
 * Display failure details
 */
function displayFailures(failures: ExecutionResult[]): void {
  console.error('Failed projects:');
  console.error('─'.repeat(80));

  for (const failure of failures) {
    console.error(`\n❌ ${failure.project}`);
    if (failure.error) {
      console.error(`   Error: ${failure.error}`);
    }
    if (failure.exitCode !== undefined) {
      console.error(`   Exit code: ${failure.exitCode}`);
    }
  }

  console.error();
}
