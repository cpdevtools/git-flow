/**
 * Build and pack execution functions
 */

import type { ProjectArtifactDescriptor } from '@cpdevtools/ts-dev-utilities/artifacts';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { $ } from 'zx';
import {
    findOrCreateDraftRelease,
    uploadArtifact
} from './github.js';
import type { BuildPackContext, ExecutionResult, ProjectConfig } from './types.js';

// Get the directory of the installed package
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '../..');
const gitflowCli = join(packageRoot, 'dist/cli/bin.js');

/**
 * Read package.json for a project
 */
async function readPackageJson(cwd: string): Promise<any> {
  const pkgPath = join(cwd, 'package.json');
  const content = await readFile(pkgPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Check if project has a build script
 */
async function hasBuildScript(project: ProjectConfig): Promise<boolean> {
  const packageJson = await readPackageJson(project.cwd);
  return !!packageJson.scripts?.['github.actions.build'];
}

/**
 * Check if project has a pack script
 */
async function hasPackScript(project: ProjectConfig): Promise<boolean> {
  const packageJson = await readPackageJson(project.cwd);
  return !!packageJson.scripts?.['github.actions.pack'];
}

/**
 * Execute build script for a project
 * @param project - Project configuration
 * @param context - Workflow context
 * @returns Execution result
 */
export async function executeBuild(
  project: ProjectConfig,
  context: BuildPackContext
): Promise<ExecutionResult> {
  if (!(await hasBuildScript(project))) {
    console.log(`⊘ ${project.name}: No build script, skipping...`);
    return {
      project: project.name,
      success: true,
    };
  }

  console.log(`🔨 ${project.name}: Building...`);

  try {
    // Set environment variables
    const env = {
      ...process.env,
      PROJECT_VERSION: project.version,
      PROJECT_NAME: project.name,
      ARTIFACT_OUTPUT_DIR: context.artifactOutputDir,
      GITHUB_SHA: context.sha,
    };

    // Apply version to project files before building
    console.log(`  📝 Applying version ${project.version}...`);
    await $({ cwd: project.cwd, env })`node ${gitflowCli} apply-version`;

    // Execute build script
    const result = await $({ cwd: project.cwd, env })`pnpm run github.actions.build`;

    console.log(`✓ ${project.name}: Build completed`);

    return {
      project: project.name,
      success: true,
      exitCode: result.exitCode ?? 0,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`✗ ${project.name}: Build failed - ${errorMessage}`);

    return {
      project: project.name,
      success: false,
      error: errorMessage,
      exitCode: 1,
    };
  }
}

/**
 * Execute pack script for a project
 * @param project - Project configuration
 * @param context - Workflow context
 * @returns Execution result
 */
export async function executePack(
  project: ProjectConfig,
  context: BuildPackContext
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
      ARTIFACT_OUTPUT_DIR: context.artifactOutputDir,
      ARTIFACT_FILENAME: artifactFilename,
      GITHUB_SHA: context.sha,
    };

    // Execute pack script
    const result = await $({ cwd: project.cwd, env })`pnpm run github.actions.pack`;

    // Verify artifact.yml was generated
    const artifactPath = join(context.artifactOutputDir, `${artifactFilename}.artifact.yml`);

    if (!existsSync(artifactPath)) {
      throw new Error(
        `Pack script must generate ${project.name}.artifact.yml in ARTIFACT_OUTPUT_DIR. ` +
          `File not found at: ${artifactPath}`
      );
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
  context: BuildPackContext
): Promise<ExecutionResult> {
  console.log(`⬆️  ${project.name}: Uploading artifacts...`);

  try {
    const artifactFilename = project.name.replace(/@/g, '').replace(/\//g, '-');
    const artifactPath = join(context.artifactOutputDir, `${artifactFilename}.artifact.yml`);

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

    // Find or create draft release
    const release = await findOrCreateDraftRelease(project, context);

    // Get owner/repo from environment
    const owner = process.env.GITHUB_REPOSITORY_OWNER || 'cpdevtools';
    const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'unknown';

    // Always upload artifact.yml file itself
    await uploadArtifact(
      context.githubToken,
      owner,
      repo,
      release.id,
      release.upload_url,
      artifactPath
    );

    // Upload artifacts based on type
    for (const artifact of descriptor.artifacts) {
      switch (artifact.type) {
        case 'npm':
          // Upload npm package file
          const npmPath = join(project.cwd, artifact.path);
          await uploadArtifact(
            context.githubToken,
            owner,
            repo,
            release.id,
            release.upload_url,
            npmPath
          );
          break;

        case 'nuget':
          // Upload nuget package file
          const nugetPath = join(project.cwd, artifact.path);
          await uploadArtifact(
            context.githubToken,
            owner,
            repo,
            release.id,
            release.upload_url,
            nugetPath
          );
          break;

        case 'release-attachment':
          // Upload release attachment file
          const attachmentPath = join(project.cwd, artifact.path);
          await uploadArtifact(
            context.githubToken,
            owner,
            repo,
            release.id,
            release.upload_url,
            attachmentPath
          );
          break;

        case 'docker':
          // Docker artifacts don't need file uploads - just metadata in artifact.yml
          console.log(`  ℹ️  Docker artifact: ${artifact.name} (metadata only, no file upload)`);
          break;

        default:
          console.warn(`  ⚠️  Unknown artifact type: ${(artifact as any).type}`);
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
