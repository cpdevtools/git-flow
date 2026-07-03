/**
 * Build and pack execution functions
 */

import type { ProjectArtifactDescriptor } from '@cpdevtools/ts-dev-utilities/artifacts';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseDocument } from 'yaml';
import { $ } from 'zx';
import { findOrCreateDraftRelease, uploadArtifact } from './github.js';
import { generateArtifactDescriptor, ARTIFACT_OUTPUT_DIR } from './generate-artifact.js';
import type { BuildPackContext, ExecutionResult, ProjectConfig } from './types.js';
import { rewriteWorkspaceDependencies, restoreProjectFiles } from './workspace-deps/index.js';

/**
 * Apply version to package.json
 */
async function applyVersionToPackageJson(cwd: string, version: string): Promise<void> {
  const pkgPath = join(cwd, 'package.json');

  if (!existsSync(pkgPath)) {
    return;
  }

  const content = await readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(content);

  pkg.version = version;

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

/**
 * Apply version to .csproj files
 */
async function applyVersionToCsproj(cwd: string, version: string): Promise<void> {
  // Find all .csproj files
  try {
    const { stdout } = await $({ cwd })`find . -maxdepth 1 -name "*.csproj"`;
    const csprojFiles = stdout.trim().split('\n').filter(Boolean);

    for (const csprojFile of csprojFiles) {
      const csprojPath = join(cwd, csprojFile);
      let content = await readFile(csprojPath, 'utf-8');

      // Update <Version> tag
      if (content.includes('<Version>')) {
        content = content.replace(/<Version>.*?<\/Version>/, `<Version>${version}</Version>`);
      } else {
        // Add Version tag if not present
        content = content.replace(
          /<PropertyGroup>/,
          `<PropertyGroup>\n    <Version>${version}</Version>`,
        );
      }

      await writeFile(csprojPath, content);
    }
  } catch (error) {
    // No .csproj files found, that's OK
  }
}

/**
 * Apply version to project files
 */
export async function applyVersion(cwd: string, version: string): Promise<void> {
  await applyVersionToPackageJson(cwd, version);
  await applyVersionToCsproj(cwd, version);
}

/**
 * Read package.json for a project
 */
async function readPackageJson(cwd: string): Promise<any> {
  const pkgPath = join(cwd, 'package.json');
  const content = await readFile(pkgPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Check if project has a pack script
 */
async function hasPackScript(project: ProjectConfig): Promise<boolean> {
  const packageJson = await readPackageJson(project.cwd);
  return !!packageJson.scripts?.['github.actions.pack'];
}

/**
 * Execute pack script for a project
 * @param project - Project configuration
 * @param context - Workflow context
 * @returns Execution result
 */
/**
 * Execute pack script for a project with workspace dependency rewriting
 * @param project - Project configuration
 * @param context - Workflow context (must include allProjects for dependency resolution)
 * @returns Execution result
 */
export async function executePack(
  project: ProjectConfig,
  context: BuildPackContext,
): Promise<ExecutionResult> {
  if (!(await hasPackScript(project))) {
    console.log(`⊘ ${project.name}: No pack script, skipping...`);
    return {
      project: project.name,
      success: true,
    };
  }

  console.log(`📦 ${project.name}: Packing & generating artifact descriptor...`);

  try {
    // Set environment variables
    const artifactFilename = project.name.replace(/@/g, '').replace(/\//g, '-');
    const env = {
      ...process.env,
      PROJECT_VERSION: project.version,
      PROJECT_NAME: project.name,
      ARTIFACT_OUTPUT_DIR,
      ARTIFACT_FILENAME: artifactFilename,
      GITHUB_SHA: context.sha,
    } as Record<string, string>;

    // Rewrite workspace dependencies before packing
    console.log(`  🔄 Rewriting workspace dependencies...`);
    await rewriteWorkspaceDependencies({
      project,
      allProjects: context.allProjects || [project],
    });

    // Execute pack script
    let result;
    try {
      // Verify CLI is available
      try {
        await $({ cwd: project.cwd, env })`which gitflow`;
        console.log(`  ✓ gitflow CLI found in PATH`);
      } catch {
        console.error(`  ⚠️  gitflow not found in PATH`);
        console.error(`  PATH: ${env.PATH}`);
      }

      result = await $({ cwd: project.cwd, env, verbose: true })`pnpm run github.actions.pack`;
      console.log(`  ✓ Pack completed`);
    } catch (error) {
      console.error(`  ✗ Pack failed:`, error);
      throw error;
    } finally {
      // Always restore files, even if pack fails
      console.log(`  ↩️  Restoring original project files...`);
      await restoreProjectFiles(project.cwd);
    }

    // Generate artifact descriptor
    const artifactPath = await generateArtifactDescriptor(
      project.cwd,
      project.name,
      project.version,
    );

    if (!existsSync(artifactPath)) {
      throw new Error(`Artifact descriptor was not generated: ${artifactPath}`);
    }

    console.log(`✓ ${project.name}: Pack completed, artifact descriptor generated`);

    return {
      project: project.name,
      success: true,
      exitCode: result.exitCode ?? 0,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`✗ ${project.name}: Pack failed - ${errorMessage}`);

    return {
      project: project.name,
      success: false,
      error: errorMessage,
      exitCode: 1,
    };
  }
}

/**
 * Execute upload for a project's artifacts
 * @param project - Project configuration
 * @param context - Workflow context
 * @returns Execution result
 */
export async function executeUpload(
  project: ProjectConfig,
  context: BuildPackContext,
): Promise<ExecutionResult> {
  console.log(`⬆️  ${project.name}: Uploading artifacts...`);

  try {
    const artifactFilename = project.name.replace(/@/g, '').replace(/\//g, '-');
    const artifactPath = join(ARTIFACT_OUTPUT_DIR, `${artifactFilename}.artifact.yml`);

    if (!existsSync(artifactPath)) {
      console.log(`  ⊘ No artifact descriptor found, skipping upload`);
      return {
        project: project.name,
        success: true,
      };
    }

    // Read artifact descriptor
    const artifactYml = await readFile(artifactPath, 'utf-8');
    const doc = parseDocument(artifactYml);
    const descriptor = doc.toJSON() as ProjectArtifactDescriptor;

    console.log(`  📄 Found ${descriptor.artifacts.length} artifact(s) to upload`);

    // Find or create draft release with artifact metadata in body
    const release = await findOrCreateDraftRelease(project, context, artifactYml);

    // Get owner/repo from environment
    const owner = process.env.GITHUB_REPOSITORY_OWNER || 'cpdevtools';
    const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'unknown';

    // Upload artifacts based on type (but NOT the artifact.yml file itself)
    for (const artifact of descriptor.artifacts) {
      switch (artifact.type) {
        case 'npm':
          // Upload npm package file
          // Path may be absolute (from artifact generation) or relative (from config)
          const npmPath = isAbsolute(artifact.path)
            ? artifact.path
            : join(context.workspaceRoot, artifact.path);
          await uploadArtifact(
            context.githubToken,
            owner,
            repo,
            release.id,
            release.upload_url,
            npmPath,
          );
          break;

        case 'nuget':
          // Upload nuget package file
          const nugetPath = isAbsolute(artifact.path)
            ? artifact.path
            : join(context.workspaceRoot, artifact.path);
          await uploadArtifact(
            context.githubToken,
            owner,
            repo,
            release.id,
            release.upload_url,
            nugetPath,
          );
          break;

        case 'release-attachment':
          // Upload release attachment file
          const attachmentPath = isAbsolute(artifact.path)
            ? artifact.path
            : join(context.workspaceRoot, artifact.path);
          await uploadArtifact(
            context.githubToken,
            owner,
            repo,
            release.id,
            release.upload_url,
            attachmentPath,
          );
          break;

        case 'docker':
          // Docker artifacts don't need file uploads - just metadata in release body
          console.log(`  ℹ️  Docker artifact: ${artifact.name} (metadata in release body)`);
          break;

        default:
          console.error(`  ⚠️  Unknown artifact type: ${(artifact as any).type}`);
      }
    }

    console.log(`✓ ${project.name}: Upload completed`);

    return {
      project: project.name,
      success: true,
      exitCode: 0,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`✗ ${project.name}: Upload failed - ${errorMessage}`);

    return {
      project: project.name,
      success: false,
      error: errorMessage,
      exitCode: 1,
    };
  }
}
