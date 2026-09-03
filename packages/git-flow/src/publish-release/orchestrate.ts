/**
 * Phase 3: Publish & Release orchestration
 */

import type { ProjectArtifactDescriptor } from '@cpdevtools/ts-dev-utilities/artifacts';
import { parseDocument } from 'yaml';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { getOctokit as getActionsOctokit } from '@actions/github';
import { discoverProjects } from '../lib/project.js';
import {
  getArtifactType,
  loadPlugins,
  providerOf,
  type PublishContext,
} from '../artifacts/index.js';
import {
  loadRegistryConfig,
  getRegistry,
  getToken,
  verifyPublication,
  type RegistryConfig,
  type Registry,
  type PublishReleaseOptions,
  type PublishReleaseResult,
  type ProjectPublishResult,
} from '../publishing/index.js';
import {
  finalizeRelease,
  createGitTag,
  getReleaseTag,
  getReleaseUrl,
  parseReleaseTag,
  getDraftReleaseMetadata,
  isReleasePublished,
  updateDraftReleaseBody,
  findDraftReleaseByTag,
  postPRReleaseComment,
  buildReleaseComment,
} from '../build-pack/github.js';

/**
 * Download release assets to local directory
 */
async function downloadReleaseAssets(
  githubToken: string,
  owner: string,
  repo: string,
  tag: string,
  outputDir: string,
): Promise<void> {
  const octokit = getActionsOctokit(githubToken);

  // Find the release
  const { data: releases } = await octokit.rest.repos.listReleases({
    owner,
    repo,
    per_page: 100,
  });

  // Parse tag to get expected release name
  // Tag format: @scope/name/vX.Y.Z -> name: "@scope/name X.Y.Z"
  // GitHub stores tags containing @ or / as untagged-<hash>, so we fall back to name match.
  const parsed = parseReleaseTag(tag);
  const expectedName = parsed ? `${parsed.name} ${parsed.version}` : null;

  // First try exact tag match, then fall back to name match for untagged releases
  const release =
    releases.find((r) => r.tag_name === tag) ||
    (expectedName ? releases.find((r) => r.draft && r.name === expectedName) : null);

  if (!release) {
    throw new Error(`Release not found for tag: ${tag}`);
  }

  // Create output directory
  await mkdir(outputDir, { recursive: true });

  // Download each asset
  for (const asset of release.assets) {
    console.log(`  ⬇️  Downloading ${asset.name}...`);

    const response = await octokit.rest.repos.getReleaseAsset({
      owner,
      repo,
      asset_id: asset.id,
      headers: {
        accept: 'application/octet-stream',
      },
    });

    const assetPath = join(outputDir, asset.name);
    await writeFile(assetPath, Buffer.from(response.data as unknown as ArrayBuffer));
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
  tag: string,
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

  // Get the draft release
  const release = await findDraftReleaseByTag(githubToken, owner, repo, tag);
  if (!release) {
    throw new Error(`Draft release not found for tag: ${tag}`);
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

        // Get artifact metadata from draft release body
        const tag = getReleaseTag(project.name, project.version);
        const artifactYml = await getDraftReleaseMetadata(
          options.githubToken,
          options.owner,
          options.repo,
          tag,
        );

        if (!artifactYml) {
          // No draft found. If a finalized release already exists for this tag,
          // the project was published on a previous run — skip it (idempotent
          // re-run) instead of failing the whole release.
          const alreadyPublished = await isReleasePublished(
            options.githubToken,
            options.owner,
            options.repo,
            tag,
          );
          if (alreadyPublished) {
            console.log(`  ⏭️  ${project.name} already released (${tag}) — skipping`);
            continue;
          }
          throw new Error(
            `No artifact metadata found in draft release ${tag}. ` +
              `Make sure the build-pack phase completed successfully.`,
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
          tag,
          artifactsDir,
        );

        // Publish each artifact to its registries
        const publishResult = await publishProjectArtifacts(
          descriptor,
          registryConfig,
          options.workspaceRoot,
          project.version,
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
          tag,
          artifactYml,
        );

        // Create git tag BEFORE finalizing release (required for GitHub to use the tag)
        console.log(`  🏷️  Creating git tag...`);
        await createGitTag(
          options.githubToken,
          options.owner,
          options.repo,
          project.name,
          project.version,
          options.sha,
          project.placeholder,
        );

        // Finalize GitHub Release (draft → published)
        console.log(`  ✅ Finalizing GitHub Release...`);
        await finalizeRelease(
          options.githubToken,
          options.owner,
          options.repo,
          project.name,
          project.version,
          project.prerelease,
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
 * Check if a registry is a GitHub-hosted registry
 */
function isGitHubRegistry(registry: Registry): boolean {
  switch (registry.type) {
    case 'npm':
      return registry.url.includes('npm.pkg.github.com');
    case 'nuget':
      return registry.url.includes('nuget.pkg.github.com');
    case 'docker':
      return (
        registry.registry.includes('ghcr.io') || registry.registry.includes('docker.pkg.github.com')
      );
    default:
      return false;
  }
}

/**
 * Check if a version is a build version (contains '.build.')
 */
function isBuildVersion(version: string): boolean {
  return version.includes('.build.');
}

/**
 * Publish all artifacts for a project
 */
async function publishProjectArtifacts(
  descriptor: ProjectArtifactDescriptor,
  registryConfig: RegistryConfig,
  workspaceRoot: string,
  projectVersion: string,
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
    const publishCtx: PublishContext = { workspaceRoot, projectVersion };

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
