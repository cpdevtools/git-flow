/**
 * Main orchestration for Phase 2 Build & Pack workflow
 */

import { join } from 'path';
import { discoverProjects, buildDependencyGraph } from '../lib/project';
import type { Project, DependencyGraph } from '../lib/project';
import { extractPRMetadata } from './options.js';
import { executeBuild, executePack, executeUpload } from './execute.js';
import { getReleaseTag, findDraftReleaseByTag, isArtifactUploaded, deleteDraftRelease } from './github.js';
import type {
  BuildPackContext,
  ProjectConfig,
  ExecutionResult,
  PRMetadata,
  PRProjectMetadata,
  BuildPackResult,
} from './types.js';

/**
 * Main entry point for build & pack workflow
 * @param context - Workflow context
 * @param prBody - Pull request body containing metadata and options
 */
export async function runBuildPack(
  context: BuildPackContext,
  prBody: string
): Promise<BuildPackResult> {
  console.log('🚀 Starting Phase 2: Build & Pack\n');

  // Extract metadata from PR body
  const metadata = extractPRMetadata(prBody);
  const allProjects = Object.values(metadata.projectsByPlaceholder).flat();
  console.log(`📋 Processing ${allProjects.length} projects from PR #${context.prNumber}`);
  console.log(`   Run: ${context.runNumber}`);
  console.log(`   SHA: ${context.sha.substring(0, 7)}`);
  
  // Display projects grouped by placeholder
  for (const [placeholder, projects] of Object.entries(metadata.projectsByPlaceholder)) {
    console.log(`   ${placeholder}: ${projects.map(p => p.name).join(', ')}`);
  }
  
  // Handle Force Rebuild if enabled
  if (metadata.forceRebuild) {
    console.log('\n🔄 Force Rebuild enabled - deleting existing draft releases...');
    const owner = process.env.GITHUB_REPOSITORY_OWNER || 'cpdevtools';
    const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'unknown';
    
    for (const project of allProjects) {
      await deleteDraftRelease(
        context.githubToken,
        owner,
        repo,
        project.name,
        project.version
      );
    }
    console.log('   ✓ Draft releases deleted');
  }
  console.log();

  // Discover all workspace projects
  console.log('🔍 Discovering workspace projects...');
  const discoveredProjects = await discoverProjects(context.workspaceRoot);
  console.log(`   Found ${discoveredProjects.length} projects:`);
  discoveredProjects.forEach(p => console.log(`     - ${p.name}`));
  console.log('');

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
    return {
      built: [],
      packed: [],
      uploaded: [],
      skipped: projectsToSkip.map(p => p.name),
      failed: [],
    };
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

  // Add allProjects to context for workspace dependency resolution
  const contextWithProjects: BuildPackContext = {
    ...context,
    allProjects: allProjectsToProcess,
  };

  // Build dependency graph and get topological batches (all projects)
  console.log('📊 Building dependency graph...');
  const graph = buildDependencyGraph(allProjectsToProcess);
  const batches = graph.batches;
  console.log(`   Organized into ${batches.length} dependency batches\n`);

  // Display execution plan
  displayExecutionPlan(batches, allProjectsToProcess, projectsToProcess);

  // Execute batches
  let allResults: ExecutionResult[] = [];
  const builtProjects: string[] = [];
  const packedProjects: string[] = [];
  const uploadedProjects: string[] = [];

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
    const results = await executeBatch(batchProjects, projectsToProcess, contextWithProjects);
    allResults.push(...results);

    // Track what was done
    for (const result of results) {
      if (result.success) {
        builtProjects.push(result.project);
        const isRelease = projectsToProcess.find(p => p.name === result.project);
        if (isRelease) {
          packedProjects.push(result.project);
          uploadedProjects.push(result.project);
        }
      }
    }

    // Count results
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    console.log(`\n✓ Batch ${batchNum} completed: ${succeeded} succeeded, ${failed} failed`);

    // Stop on first failure
    if (failed > 0) {
      console.error(`\n❌ Build & Pack failed. Stopping execution.\n`);
      displayFailures(results.filter((r) => !r.success));
      break;
    }
  }

  const failedResults = allResults.filter(r => !r.success);
  const totalSuccess = allResults.filter(r => r.success).length;

  // Final summary
  console.log(`\n${'='.repeat(80)}`);
  if (failedResults.length === 0) {
    console.log(`✅ Phase 2 Complete: ${totalSuccess} projects succeeded`);
  } else {
    console.log(`⚠️  Phase 2 Completed with errors: ${totalSuccess} succeeded, ${failedResults.length} failed`);
  }
  console.log(`${'='.repeat(80)}\n`);

  return {
    built: builtProjects,
    packed: packedProjects,
    uploaded: uploadedProjects,
    skipped: projectsToSkip.map(p => p.name),
    failed: failedResults,
  };
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
  const allProjects = Object.values(metadata.projectsByPlaceholder).flat();

  for (const prProject of allProjects) {
    console.log(`   Looking for project: "${prProject.name}"`);
    // Find matching discovered project
    const discovered = discoveredProjects.find((p) => p.name === prProject.name);
    console.log(`   Found match: ${discovered ? 'YES' : 'NO'}`);

    if (!discovered) {
      console.log(`   Available projects: ${discoveredProjects.map(p => `"${p.name}"`).join(', ')}`);
      throw new Error(
        `Project ${prProject.name} from PR metadata not found in workspace`
      );
    }

    configs.push({
      ...discovered,
      name: prProject.name,
      cwd: discovered.directory, // Use the discovered project's actual directory
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
          artifactFileName
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
      console.log(`    ⚠️  Error checking ${project.name}: ${error instanceof Error ? error.message : String(error)}`);
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

      // Upload (skip if configured)
      if (context.skipUpload) {
        console.log(`⊘ ${project.name}: Skipping upload (SKIP_UPLOAD enabled)`);
        return packResult;
      }

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
