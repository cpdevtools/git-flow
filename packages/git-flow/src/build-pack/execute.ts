/**
 * Build and pack execution functions
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectConfig, ExecutionResult, BuildPackContext } from './types.js';

/**
 * Read package.json synchronously
 */
function readPackageJsonSync(cwd: string): any {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(`package.json not found at ${pkgPath}`);
  }
  // In real implementation, use proper JSON parsing
  return JSON.parse(require('fs').readFileSync(pkgPath, 'utf-8'));
}

/**
 * Check if project has a build script
 */
function hasBuildScript(project: ProjectConfig): boolean {
  const packageJson = readPackageJsonSync(project.cwd);
  return !!packageJson.scripts?.['github.actions.build'];
}

/**
 * Check if project has a pack script
 */
function hasPackScript(project: ProjectConfig): boolean {
  const packageJson = readPackageJsonSync(project.cwd);
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
  if (!hasBuildScript(project)) {
    console.log(`⊘ ${project.name}: No build script, skipping...`);
    return {
      project: project.name,
      success: true,
    };
  }

  console.log(`🔨 ${project.name}: Building...`);

  try {
    // PLACEHOLDER: This is where we would execute the build script
    // In real implementation:
    // - Set environment variables (PROJECT_VERSION, PROJECT_NAME, etc.)
    // - Execute: pnpm run github.actions.build
    // - Stream output to console
    // - Capture exit code
    // - Handle errors

    console.log(`  📝 Would execute: pnpm run github.actions.build`);
    console.log(`  📂 Working directory: ${project.cwd}`);
    console.log(`  🔢 PROJECT_VERSION: ${project.version}`);
    console.log(`  🏷️  PROJECT_NAME: ${project.name}`);
    console.log(`  📦 ARTIFACT_OUTPUT_DIR: ${context.artifactOutputDir}`);

    // Simulate success
    console.log(`✓ ${project.name}: Build completed`);

    return {
      project: project.name,
      success: true,
      exitCode: 0,
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
  if (!hasPackScript(project)) {
    console.log(`⊘ ${project.name}: No pack script, skipping...`);
    return {
      project: project.name,
      success: true,
    };
  }

  console.log(`📦 ${project.name}: Packing & generating artifact descriptor...`);

  try {
    // PLACEHOLDER: This is where we would execute the pack script
    // In real implementation:
    // - Set environment variables (PROJECT_VERSION, PROJECT_NAME, ARTIFACT_OUTPUT_DIR, etc.)
    // - Execute: pnpm run github.actions.pack
    // - Stream output to console
    // - Capture exit code
    // - Handle errors

    console.log(`  📝 Would execute: pnpm run github.actions.pack`);
    console.log(`  📂 Working directory: ${project.cwd}`);
    console.log(`  🔢 PROJECT_VERSION: ${project.version}`);
    console.log(`  🏷️  PROJECT_NAME: ${project.name}`);
    console.log(`  📦 ARTIFACT_OUTPUT_DIR: ${context.artifactOutputDir}`);
    console.log(`  📄 GITHUB_SHA: ${context.sha}`);

    // Verify artifact.yml was generated
    const artifactPath = join(context.artifactOutputDir, `${project.name}.artifact.yml`);

    // PLACEHOLDER: In real implementation, this check happens after actual script execution
    console.log(`  🔍 Would verify artifact file exists: ${artifactPath}`);

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
      exitCode: 0,
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
    // PLACEHOLDER: This is where we would upload artifacts
    // In real implementation:
    // - Read artifact.yml to discover what to upload
    // - Create/find draft release
    // - Upload artifact.yml file (always)
    // - Upload package files (npm, nuget, release-attachments)
    // - Skip large file uploads for Docker (just upload artifact.yml with metadata)

    const artifactPath = join(context.artifactOutputDir, `${project.name}.artifact.yml`);

    if (!existsSync(artifactPath)) {
      console.log(`  ⊘ No artifact descriptor found, skipping upload`);
      return {
        project: project.name,
        success: true,
      };
    }

    console.log(`  📝 Would read artifact descriptor: ${artifactPath}`);
    console.log(`  🏷️  Would create/find draft release: ${project.name}-v${project.version}`);
    console.log(`  📤 Would upload artifact.yml to release`);
    console.log(`  📤 Would upload artifact files based on type`);

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
