/**
 * Build and pack execution functions
 */

import type { ProjectArtifactDescriptor } from '@cpdevtools/ts-dev-utilities/artifacts';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, parseDocument, stringify } from 'yaml';
import { $ } from 'zx';
import { getArtifactType, type Artifact, type UploadContext } from '../artifacts/index.js';
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

    // The descriptor path produced by packing.  Must be generated while the
    // project files are still bumped/rewritten (before restoreProjectFiles).
    const artifactPath = join(ARTIFACT_OUTPUT_DIR, `${artifactFilename}.artifact.yml`);

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

      // Generate the descriptor while files are still bumped/rewritten.
      // If the pack script already produced it (e.g. `gitflow pack`), skip to
      // avoid re-running pack handlers (which would re-pack / re-push docker).
      if (!existsSync(artifactPath)) {
        await generateArtifactDescriptor(project.cwd, project.name, project.version);
      }
    } catch (error) {
      console.error(`  ✗ Pack failed:`, error);
      throw error;
    } finally {
      // Always restore files, even if pack fails
      console.log(`  ↩️  Restoring original project files...`);
      await restoreProjectFiles(project.cwd);
    }

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
 * Execute pack-deploy for a project.
 *
 * New convention path: artifacts in the descriptor that carry a `deploy: string[]` field
 * each get one `github.actions.pack-deploy-{method}` script invocation per method.
 * The orchestrator validates deploy.yml, injects release metadata, zips and uploads
 * each bundle directly as `deploy-{method}.zip`.
 *
 * Legacy path (backward compat): if no artifact carries a `deploy:` array but the
 * project has a `github.actions.pack-deploy` script, that script is run as before.
 */
async function executePackDeploy(
  project: ProjectConfig,
  context: BuildPackContext,
  descriptor: ProjectArtifactDescriptor,
  uploadCtx: UploadContext,
): Promise<void> {
  type WithDeploy = { deploy?: string[] };
  const artifactsWithDeploy = descriptor.artifacts.filter(
    (a: Artifact) => Array.isArray((a as unknown as WithDeploy).deploy) && ((a as unknown as WithDeploy).deploy as string[]).length > 0,
  );

  if (artifactsWithDeploy.length > 0) {
    // ── New convention-based path ──────────────────────────────────────────
    const packageJson = await readPackageJson(project.cwd);
    for (const artifact of artifactsWithDeploy) {
      const methods = (artifact as WithDeploy).deploy as string[];
      for (const method of methods) {
        const scriptName = `github.actions.pack-deploy-${method}`;
        if (!packageJson.scripts?.[scriptName]) {
          console.log(`  \u22d8 ${project.name}: No ${scriptName} script, skipping ${method} deploy`);
          continue;
        }

        console.log(`  \ud83d\ude80 ${project.name}: pack-deploy-${method}...`);

        const deployOutputDir = join(project.cwd, '.deploy-output', method);
        await mkdir(deployOutputDir, { recursive: true });

        const env = {
          ...process.env,
          PROJECT_VERSION: project.version,
          PROJECT_NAME: project.name,
          ARTIFACT_OUTPUT_DIR,
          DEPLOY_OUTPUT_DIR: deployOutputDir,
          GITHUB_RELEASE_ID: String(uploadCtx.releaseId),
          GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY ?? '',
          GITHUB_SHA: context.sha,
        } as Record<string, string>;

        await $({ cwd: project.cwd, env })`pnpm run ${scriptName}`;

        // Validate and inject metadata into deploy.yml
        const deployYmlPath = join(deployOutputDir, 'deploy.yml');
        if (!existsSync(deployYmlPath)) {
          throw new Error(
            `${scriptName} did not produce deploy.yml in ${deployOutputDir}.\n` +
              `The pack-deploy script must write deploy.yml with at least deployCommand.`,
          );
        }
        const deployMeta = parse(await readFile(deployYmlPath, 'utf-8')) as Record<string, unknown>;
        if (!deployMeta.deployCommand) {
          throw new Error(`deploy.yml produced by ${scriptName} is missing required field: deployCommand`);
        }
        await writeFile(
          deployYmlPath,
          stringify({
            ...deployMeta,
            name: project.name,
            version: project.version,
            repo: `https://github.com/${process.env.GITHUB_REPOSITORY ?? ''}`,
            releaseId: uploadCtx.releaseId,
          }),
        );

        // Zip the deploy output dir and upload directly
        const zipName = `deploy-${method}.zip`;
        const zipPath = join(ARTIFACT_OUTPUT_DIR, zipName);
        await mkdir(ARTIFACT_OUTPUT_DIR, { recursive: true });
        await $({ cwd: deployOutputDir })`zip -r ${zipPath} .`;

        await uploadArtifact(
          uploadCtx.githubToken,
          uploadCtx.owner,
          uploadCtx.repo,
          uploadCtx.releaseId,
          uploadCtx.uploadUrl,
          zipPath,
          zipName,
        );
        console.log(`  \u2713 ${project.name}: ${zipName} uploaded`);
      }
    }
    return;
  }

  // ── Legacy path: single github.actions.pack-deploy script ─────────────────
  const packageJson = await readPackageJson(project.cwd);
  if (!packageJson.scripts?.['github.actions.pack-deploy']) {
    return;
  }

  console.log(`\ud83d\ude80 ${project.name}: Running pack-deploy (legacy)...`);

  const env = {
    ...process.env,
    PROJECT_VERSION: project.version,
    PROJECT_NAME: project.name,
    ARTIFACT_OUTPUT_DIR,
    DEPLOY_OUTPUT_DIR: join(project.cwd, '.deploy-output'),
    GITHUB_RELEASE_ID: String(uploadCtx.releaseId),
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY ?? '',
    GITHUB_SHA: context.sha,
  } as Record<string, string>;

  await $({ cwd: project.cwd, env })`pnpm run github.actions.pack-deploy`;
  console.log(`\u2713 ${project.name}: pack-deploy completed`);
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

    const uploadCtx: UploadContext = {
      githubToken: context.githubToken,
      owner,
      repo,
      releaseId: release.id,
      uploadUrl: release.upload_url,
      workspaceRoot: context.workspaceRoot,
    };

    // Run pack-deploy (convention-based or legacy) now that we have the release ID
    await executePackDeploy(project, context, descriptor, uploadCtx);

    // Determine if the new convention path was used (deploy: arrays on artifacts)
    type WithDeploy = { deploy?: string[] };
    const hasConventionDeploy = descriptor.artifacts.some(
      (a: Artifact) => Array.isArray((a as unknown as WithDeploy).deploy) && ((a as unknown as WithDeploy).deploy as string[]).length > 0,
    );

    // Re-read descriptor for legacy path — pack-deploy may have updated deploy artifact paths
    const uploadDescriptor = hasConventionDeploy
      ? descriptor
      : (parseDocument(await readFile(artifactPath, 'utf-8')).toJSON() as ProjectArtifactDescriptor);

    for (const artifact of uploadDescriptor.artifacts) {
      // Convention deploy bundles are already uploaded inside executePackDeploy; skip type:deploy entries
      if (artifact.type === 'deploy' && hasConventionDeploy) continue;
      await getArtifactType(artifact.type).upload(artifact, uploadCtx);
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
