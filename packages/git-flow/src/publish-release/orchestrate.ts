/**
 * Phase 3: Publish & Release orchestration
 */

import type { ProjectArtifactDescriptor } from '@cpdevtools/ts-dev-utilities/artifacts';
import { parseDocument } from 'yaml';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { discoverProjects } from '../lib/project.js';
import {
  getArtifactType,
  loadPlugins,
  providerOf,
  type PublishContext,
} from '../artifacts/index.js';
import {
  computeFloatingTags,
  loadRegistryConfig,
  getRegistry,
  getToken,
  isBuildVersion,
  isGitHubRegistry,
  verifyPublication,
  type RegistryConfig,
  type PublishReleaseOptions,
  type PublishReleaseResult,
  type ProjectPublishResult,
} from '../publishing/index.js';
import {
  finalizeReleaseById,
  createGitTag,
  getReleaseTag,
  getReleaseUrl,
  listProjectVersions,
  resolveRelease,
  extractArtifactMetadataYaml,
  downloadReleaseAsset,
  updateDraftReleaseBody,
  postPRReleaseComment,
  buildReleaseComment,
  type ReleaseInfo,
} from '../build-pack/github.js';

/**
 * Download a release's assets to a local directory.
 */
async function downloadReleaseAssets(
  githubToken: string,
  owner: string,
  repo: string,
  release: ReleaseInfo,
  outputDir: string,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  for (const asset of release.assets) {
    console.log(`  ⬇️  Downloading ${asset.name}...`);
    const bytes = await downloadReleaseAsset(githubToken, owner, repo, asset.id);
    const assetPath = join(outputDir, asset.name);
    await writeFile(assetPath, bytes);
    console.log(`  ✓ Downloaded to ${assetPath}`);
  }
}

/**
 * Update release body to mark all artifacts as published:true
 */
async function updateReleaseBodyPublishedFlags(
  githubToken: string,
  owner: string,
  repo: string,
  release: ReleaseInfo,
  artifactYml: string,
): Promise<void> {
  // Parse YAML and update published flags
  const doc = parseDocument(artifactYml);
  const descriptor = doc.toJSON() as ProjectArtifactDescriptor;

  // Set published:true for all artifacts
  if (descriptor.artifacts) {
    for (let i = 0; i < descriptor.artifacts.length; i++) {
      const artifactNode = doc.getIn(['artifacts', i]) as any;
      if (artifactNode) {
        artifactNode.set('published', true);
      }
    }
  }

  // Parse existing body to preserve PR link and tags sections
  const existingBody = release.body || '';
  const artifactMetadataMatch = existingBody.match(/## Artifact Metadata\n```yaml\n[\s\S]*?\n```/);

  // Extract PR link and tags sections from existing body
  let prAndTagsSections = '';
  if (artifactMetadataMatch) {
    // Extract everything before the artifact metadata section
    prAndTagsSections = existingBody.substring(0, artifactMetadataMatch.index || 0).trim();
  } else {
    // No artifact metadata section found, preserve entire existing body
    prAndTagsSections = existingBody.trim();
  }

  // Update release body preserving PR link, tags, and updating artifact metadata
  const updatedYaml = doc.toString();
  const artifactSection = `## Artifact Metadata\n\`\`\`yaml\n${updatedYaml}\n\`\`\``;
  const body = prAndTagsSections ? `${prAndTagsSections}\n\n${artifactSection}` : artifactSection;

  await updateDraftReleaseBody(githubToken, owner, repo, release.id, body);
}

/**
 * Main orchestration function for publishing and releasing
 */
export async function runPublishRelease(
  options: PublishReleaseOptions,
): Promise<PublishReleaseResult> {
  const result: PublishReleaseResult = {
    published: [],
    verified: [],
    failed: [],
  };

  try {
    // Publish dispatches through the same handler registry as pack, so plugin
    // types have to be registered here too — this process never reads
    // release-artifacts.yml, which is why a plugin artifact used to reach
    // publish and fail with 'Unknown artifact type'. Project directories are
    // walked as well: the ladder's 'project' rung is a plugin declared in a
    // member's own package.json, invisible from the workspace root.
    await loadPlugins({ workspaceRoot: options.workspaceRoot });
    for (const projectDir of await discoverProjects(options.workspaceRoot)) {
      await loadPlugins({ workspaceRoot: options.workspaceRoot, projectCwd: projectDir.directory });
    }

    // Load registry configuration
    const registryConfig = await loadRegistryConfig(options.workspaceRoot);

    // Process projects in order (fail-fast on error)
    for (const project of options.projects) {
      try {
        console.log(`📦 Publishing ${project.name}...`);

        // The release build-pack created: by the id it recorded in the release
        // PR, else by list scan (PRs built before ids were recorded). Fetched
        // once; every later step works from this object and its id, never
        // from another list scan.
        const tag = getReleaseTag(project.name, project.version);
        const release = await resolveRelease(
          options.githubToken,
          options.owner,
          options.repo,
          { tag, releaseId: project.releaseId },
        );

        if (!release) {
          throw new Error(
            `Release not found for ${tag}` +
              (project.releaseId !== undefined ? ` (id ${project.releaseId} returned 404)` : '') +
              `. Make sure the build-pack phase completed successfully.`,
          );
        }

        const artifactYml = extractArtifactMetadataYaml(release.body);
        if (!artifactYml) {
          throw new Error(
            `No artifact metadata found in release ${tag} (id ${release.id}). ` +
              `Make sure the build-pack phase completed successfully.`,
          );
        }

        // A published release here means a previous run got past finalize and
        // failed later (or was re-run after success). Every remaining step is
        // idempotent, so resume rather than skip: the registry promotion and
        // the extra tags may still be missing.
        if (!release.draft) {
          console.log(
            `  ℹ️  ${tag} is already published (id ${release.id}) — resuming registries, body and tags`,
          );
        }

        const doc = parseDocument(artifactYml);
        const descriptor = doc.toJSON() as ProjectArtifactDescriptor;

        // Download artifacts from GitHub release to local directory
        console.log(`  ⬇️  Downloading artifacts from release...`);
        const artifactsDir = join(options.workspaceRoot, '.artifacts');
        await downloadReleaseAssets(
          options.githubToken,
          options.owner,
          options.repo,
          release,
          artifactsDir,
        );

        // Which pointers this version earns, judged against every version the
        // project has ever tagged. Computed once here — it is a property of the
        // project, not of any one artifact or registry.
        const existingVersions = await listProjectVersions(
          options.githubToken,
          options.owner,
          options.repo,
          project.name,
        );
        const floatingTags = computeFloatingTags(project.version, existingVersions);
        console.log(
          floatingTags.length > 0
            ? `  🏷️  Floating tags: ${floatingTags.join(', ')}`
            : `  🏷️  Floating tags: none (${project.version} is not the highest of its kind)`,
        );

        // Publish each artifact to its registries
        const publishResult = await publishProjectArtifacts(
          descriptor,
          registryConfig,
          options.workspaceRoot,
          project.version,
          floatingTags,
        );

        if (!publishResult.success) {
          throw new Error(publishResult.error || 'Unknown error');
        }

        // Update release body with published:true for all artifacts
        console.log(`  📝 Updating release body with published flags...`);
        await updateReleaseBodyPublishedFlags(
          options.githubToken,
          options.owner,
          options.repo,
          release,
          artifactYml,
        );

        // Finalize (draft → published) BEFORE creating any git tags. Setting
        // tag_name on publish makes GitHub create the package tag itself, so a
        // failure up to here leaves a clean draft and no orphan tags. This
        // stays after the registry push: the deploy service treats any
        // non-draft release as deployable.
        if (release.draft) {
          console.log(`  ✅ Finalizing GitHub Release...`);
          await finalizeReleaseById(
            options.githubToken,
            options.owner,
            options.repo,
            release.id,
            tag,
            options.sha,
            project.prerelease,
          );
        }

        // Group and simple version tags (the package tag already exists;
        // createGitTag tolerates that).
        console.log(`  🏷️  Creating git tags...`);
        await createGitTag(
          options.githubToken,
          options.owner,
          options.repo,
          project.name,
          project.version,
          options.sha,
          project.placeholder,
        );

        result.published.push(project.name);
        result.verified.push(project.name);
        console.log(`✅ Published and finalized ${project.name}\n`);
      } catch (error) {
        console.error(`❌ Failed to publish ${project.name}:`, error);

        const failedProject: ProjectPublishResult = {
          project: project.name,
          success: false,
          published: [],
          verified: [],
          error: error instanceof Error ? error.message : String(error),
        };

        result.failed.push(failedProject);

        // FAIL FAST - stop processing remaining projects
        throw new Error(
          `Publishing failed for ${project.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    console.log('✅ All projects published and finalized');

    // Post comment on PR with release links
    if (result.published.length > 0) {
      console.log(`\n💬 Posting release links to PR #${options.prNumber}...`);
      // Always the tag URL, never the draft's `html_url`: by this point the
      // release has been published, so the tag exists and the untagged- URL a
      // still-draft lookup would return is already dead.
      const releaseLinks = options.projects.map((project) => ({
        name: project.name,
        version: project.version,
        url: getReleaseUrl(options.owner, options.repo, project.name, project.version),
        tag: getReleaseTag(project.name, project.version),
      }));

      await postPRReleaseComment(
        options.githubToken,
        options.owner,
        options.repo,
        options.prNumber,
        releaseLinks,
      );

      // Expose the same markdown to callers (e.g. the action step summary).
      result.releaseComment = buildReleaseComment(releaseLinks);
    }

    return result;
  } catch (error) {
    console.error('❌ Release failed:', error);
    throw error;
  }
}

/**
 * Publish all artifacts for a project
 */
async function publishProjectArtifacts(
  descriptor: ProjectArtifactDescriptor,
  registryConfig: RegistryConfig,
  workspaceRoot: string,
  projectVersion: string,
  floatingTags: string[],
): Promise<ProjectPublishResult> {
  const result: ProjectPublishResult = {
    project: descriptor.project,
    success: true,
    published: [],
    verified: [],
  };

  const isBuild = isBuildVersion(projectVersion);
  if (isBuild) {
    console.log(`  ℹ️  Build version detected (.build.) - will only publish to GitHub registries`);
  }

  try {
    const publishCtx: PublishContext = { workspaceRoot, projectVersion, floatingTags };

    for (const artifact of descriptor.artifacts) {
      const registries = getArtifactType(artifact.type, providerOf(artifact)).getRegistries(
        artifact,
      );

      for (const registryId of registries) {
        const registry = getRegistry(registryConfig, registryId);

        // Skip non-GitHub registries for build versions
        if (isBuild && !isGitHubRegistry(registry)) {
          console.log(
            `  ⏭️  Skipping ${artifact.name} → ${registryId} (build versions only publish to GitHub registries)`,
          );
          continue;
        }

        const token = getToken(registry);

        // Skip if already published
        const artifactVersion = getArtifactType(artifact.type, providerOf(artifact)).getVersion(
          artifact,
          projectVersion,
        );

        const verification = await verifyPublication(
          artifact.name,
          artifactVersion,
          registry,
          token,
        );

        if (verification.published) {
          console.log(`  ⏭️  Skipping ${artifact.name} - already published to ${registryId}`);
          continue;
        }

        // Publish to registry
        console.log(`  🚀 Publishing ${artifact.name} to ${registryId}...`);
        await getArtifactType(artifact.type, providerOf(artifact)).publish(
          artifact,
          registry,
          publishCtx,
        );

        // Verify publication
        const postVerification = await verifyPublication(
          artifact.name,
          artifactVersion,
          registry,
          token,
        );

        if (!postVerification.published) {
          throw new Error(
            `Verification failed for ${artifact.name} in ${registryId}: ${postVerification.error}`,
          );
        }

        console.log(`  ✓ Verified ${artifact.name} in ${registryId}`);
        result.published.push(`${artifact.name}@${registryId}`);
        result.verified.push(`${artifact.name}@${registryId}`);
      }
    }

    return result;
  } catch (error) {
    result.success = false;
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}
