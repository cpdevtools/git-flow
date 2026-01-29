/**
 * Main orchestration for Phase 2 Build & Pack workflow
 */

import { join } from 'node:path';
import { discoverProjects, buildDependencyGraph } from '@cpdevtools/ts-dev-utilities/project';
import type { Project } from '@cpdevtools/ts-dev-utilities/project';
import { extractPRMetadata } from './options.js';
import { executeBuild, executePack, executeUpload } from './execute.js';
import type {
  BuildPackContext,
  ProjectConfig,
  ExecutionResult,
  PRMetadata,
  PRProjectMetadata,
} from './types.js';

/**
 * Main entry point for build & pack workflow
 * @param context - Workflow context
 * @param prBody - Pull request body containing metadata and options
 */
export async function runBuildPack(
  context: BuildPackContext,
  prBody: string
): Promise<void> {
  console.log('🚀 Starting Phase 2: Build & Pack\n');

  // Extract metadata from PR body
  const metadata = extractPRMetadata(prBody);
  console.log(`📋 Processing ${metadata.projects.length} projects from PR #${context.prNumber}`);
  console.log(`   SHA: ${metadata.sha}`);
  console.log(`   Source branch: ${metadata.sourceBranch}\n`);

  // Discover all workspace projects
  console.log('🔍 Discovering workspace projects...');
  const discoveredProjects = await discoverProjects({
    cwd: context.workspaceRoot,
  });
  console.log(`   Found ${discoveredProjects.length} projects\n`);

  // Build project configurations from metadata (projects to pack/publish)
  const projectsToRelease = buildProjectConfigs(
    metadata,
    discoveredProjects,
    context
  );

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
    p => !projectsToSkip.find(skip => skip.name === p.name)
  );

  if (projectsToProcess.length === 0) {
    console.log('✅ All projects already have artifacts uploaded. Nothing to do.');
    return;
  }

  console.log(`📦 Projects remaining to release: ${projectsToProcess.map(p => p.name).join(', ')}\n`);

  // Find all dependencies that need to be built (but not necessarily packed)
  const allProjectsToProcess = findAllDependencies(
    projectsToProcess,
    discoveredProjects,
    context
  );

  const dependenciesOnly = allProjectsToProcess.filter(
    p => !projectsToProcess.find(r => r.name === p.name)
  );
  
  if (dependenciesOnly.length > 0) {
    console.log(`🔧 Additional dependencies to build: ${dependenciesOnly.map(p => p.name).join(', ')}`);
  } else {
    console.log(`🔧 No additional dependencies needed`);
  }
  console.log();

  // Build dependency graph and get topological batches (all projects)
  console.log('📊 Building dependency graph...');
  const graph = buildDependencyGraph(allProjectsToProcess);
  const batches = graph.getTopologicalBatches();
  console.log(`   Organized into ${batches.length} dependency batches\n`);

  // Display execution plan
  displayExecutionPlan(batches, allProjectsToProcess, projectsToProcess);

  // Execute batches
  let totalSuccess = 0;
  let totalFailed = 0;

  for (let i = 0; i < batches.length; i++) {
    const batchNum = i + 1;
    const batch = batches[i];
    const batchProjects = batch.map((p: Project) =>
      allProjectsToProcess.find((pc) => pc.name === p.name)!
    );

    console.log(`\n${'='.repeat(80)}`);
    console.log(`📦 Batch ${batchNum}/${batches.length} (${batchProjects.length} projects)`);
    console.log(`${'='.repeat(80)}\n`);

    // Execute batch in parallel
    const results = await executeBatch(batchProjects, projectsToProcess, context);

    // Count results
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    totalSuccess += succeeded;
    totalFailed += failed;

    console.log(`\n✓ Batch ${batchNum} completed: ${succeeded} succeeded, ${failed} failed`);

    // Stop on first failure
    if (failed > 0) {
      console.error(`\n❌ Build & Pack failed. Stopping execution.\n`);
      displayFailures(results.filter((r) => !r.success));
      process.exit(1);
    }
  }

  // Final summary
  console.log(`\n${'='.repeat(80)}`);
  console.log(`✅ Phase 2 Complete: ${totalSuccess} projects succeeded`);
  console.log(`${'='.repeat(80)}\n`);
}

/**
 * Build project configurations from PR metadata
 */
function buildProjectConfigs(
  metadata: PRMetadata,
  discoveredProjects: Project[],
  context: BuildPackContext
): ProjectConfig[] {
  const configs: ProjectConfig[] = [];

  for (const prProject of metadata.projects) {
    // Find matching discovered project
    const discovered = discoveredProjects.find((p) => p.name === prProject.name);

    if (!discovered) {
      throw new Error(
        `Project ${prProject.name} from PR metadata not found in workspace`
      );
    }

    configs.push({
      ...discovered,
      name: prProject.name,
      cwd: join(context.workspaceRoot, prProject.cwd),
      version: prProject.version,
      prerelease: prProject.prerelease,
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
  context: BuildPackContext
): Promise<ProjectConfig[]> {
  const completed: ProjectConfig[] = [];

  // PLACEHOLDER: Check GitHub releases for existing artifacts
  // In real implementation:
  // 1. For each project, construct release tag: `${project.name}-v${project.version}`
  // 2. Call GitHub API to get draft release by tag
  // 3. Check if release has an asset named `${project.name}.artifact.yml`
  // 4. If found, add to completed list

  console.log('  [PLACEHOLDER] Would check GitHub API for existing draft releases and artifacts');
  
  for (const project of projectsToRelease) {
    const releaseTag = `${project.name}-v${project.version}`;
    console.log(`    • Checking ${releaseTag}...`);
    
    // Simulating check - in real code:
    // const release = await findDraftReleaseByTag(context.githubToken, releaseTag);
    // if (release) {
    //   const hasArtifact = release.assets.some(a => a.name === `${project.name}.artifact.yml`);
    //   if (hasArtifact) {
    //     completed.push(project);
    //   }
    // }
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
  context: BuildPackContext
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
      const depProject = discoveredProjects.find(p => p.name === depName);
      if (depProject) {
        // Create a config for this dependency (not for release, just for build)
        const depConfig: ProjectConfig = {
          ...depProject,
          name: depProject.name,
          cwd: depProject.directory,
          version: depProject.packageJson.version || '0.0.0',
          prerelease: false,
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
  batches: Project[][],
  allProjects: ProjectConfig[],
  projectsToRelease: ProjectConfig[]
): void {
  console.log('📋 Execution Plan:');
  console.log('─'.repeat(80));

  for (let i = 0; i < batches.length; i++) {
    const batchProjects = batches[i];
    console.log(`\nBatch ${i + 1}:`);

    for (const project of batchProjects) {
      const config = allProjects.find((p) => p.name === project.name)!;
      const isRelease = projectsToRelease.find(p => p.name === config.name);
      const flags: string[] = [];

      if (isRelease) {
        flags.push('RELEASE');
      } else {
        flags.push('build-only');
      }

      const flagsStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
      console.log(`  • ${config.name} v${config.version}${flagsStr}`);
    }
  }

  console.log();
}

/**
 * Execute a batch of projects in parallel
 */
async function executeBatch(
  projects: ProjectConfig[],
  projectsToRelease: ProjectConfig[],
  context: BuildPackContext
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];

  // Execute each project's pipeline: Build → Pack (if releasing) → Upload (if releasing)
  const promises = projects.map(async (project) => {
    const isRelease = projectsToRelease.find(p => p.name === project.name);
    const releaseLabel = isRelease ? '📦 RELEASE' : '🔧 DEPENDENCY';
    
    console.log(`\n▶️  ${releaseLabel} ${project.name} v${project.version}: Starting pipeline...`);

    // Build (always required)
    const buildResult = await executeBuild(project, context);
    if (!buildResult.success) {
      return buildResult;
    }

    // Only pack and upload if this project is in the release list
    if (isRelease) {
      // Pack
      const packResult = await executePack(project, context);
      if (!packResult.success) {
        return packResult;
      }

      // Upload
      const uploadResult = await executeUpload(project, context);
      return uploadResult;
    } else {
      console.log(`✓ ${project.name}: Build completed (dependency only, skipping pack/upload)`);
      return buildResult;
    }
  });

  // Wait for all projects to complete
  const settled = await Promise.allSettled(promises);

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results.push(result.value);
    } else {
      // Unexpected promise rejection
      results.push({
        project: 'unknown',
        success: false,
        error: result.reason?.message || String(result.reason),
      });
    }
  }

  return results;
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
