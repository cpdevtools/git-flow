/**
 * Phase 3: Publish & Release orchestration
 */

import type { ProjectArtifactDescriptor, Artifact } from '@cpdevtools/ts-dev-utilities/artifacts';
import { parseDocument } from 'yaml';
import { join, basename } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { getOctokit as getActionsOctokit } from '@actions/github';
import {
  loadRegistryConfig,
  getRegistry,
  getToken,
  publishToNpm,
  publishToNuget,
  publishToDocker,
  verifyPublication,
  type RegistryConfig,
  type Registry,
  type NpmRegistry,
  type NugetRegistry,
  type DockerRegistry,
  type PublishReleaseOptions,
  type PublishReleaseResult,
  type ProjectPublishResult,
} from '../publishing/index.js';
import { 
  finalizeRelease, 
  createGitTag, 
  getReleaseTag,
  getDraftReleaseMetadata,
  updateDraftReleaseBody,
  findDraftReleaseByTag,
  postPRReleaseComment
} from '../build-pack/github.js';

/**
 * Download release assets to local directory
 */
async function downloadReleaseAssets(
  githubToken: string,
  owner: string,
  repo: string,
  tag: string,
  outputDir: string
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
  const tagMatch = tag.match(/^(.+)\/v(.+)$/);
  const expectedName = tagMatch ? `${tagMatch[1]} ${tagMatch[2]}` : null;

  // First try exact tag match, then fall back to name match for untagged releases
  const release = releases.find(r => r.tag_name === tag) || 
                  (expectedName ? releases.find(r => r.draft && r.name === expectedName) : null);
  
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
  artifactYml: string
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
  
  // Extract project name and version from tag for body
  const tagMatch = tag.match(/^(.+)\/v(.+)$/);
  const projectName = tagMatch ? tagMatch[1] : 'Unknown';
  const version = tagMatch ? tagMatch[2] : '0.0.0';
  
  // Update release body with new YAML
  const updatedYaml = doc.toString();
  const body = `## Artifact Metadata\n\`\`\`yaml\n${updatedYaml}\n\`\`\``;
  
  await updateDraftReleaseBody(githubToken, owner, repo, release.id, body);
}

/**
 * Main orchestration function for publishing and releasing
 */
export async function runPublishRelease(
  options: PublishReleaseOptions
): Promise<PublishReleaseResult> {
  const result: PublishReleaseResult = {
    published: [],
    verified: [],
    failed: [],
  };

  try {
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
          tag
        );

        if (!artifactYml) {
          throw new Error(
            `No artifact metadata found in draft release ${tag}. ` +
            `Make sure the build-pack phase completed successfully.`
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
          artifactsDir
        );

        // Publish each artifact to its registries
        const publishResult = await publishProjectArtifacts(
          descriptor,
          registryConfig,
          options.workspaceRoot,
          project.version
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
          artifactYml
        );

        // Create git tag BEFORE finalizing release (required for GitHub to use the tag)
        console.log(`  🏷️  Creating git tag...`);
        await createGitTag(
          options.githubToken,
          options.owner,
          options.repo,
          project.name,
          project.version,
          options.sha
        );

        // Finalize GitHub Release (draft → published)
        console.log(`  ✅ Finalizing GitHub Release...`);
        await finalizeRelease(
          options.githubToken,
          options.owner,
          options.repo,
          project.name,
          project.version,
          project.prerelease
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
          }`
        );
      }
    }

    console.log('✅ All projects published and finalized');

    // Post comment on PR with release links
    if (result.published.length > 0) {
      console.log(`\n💬 Posting release links to PR #${options.prNumber}...`);
      const releaseLinks = await Promise.all(
        options.projects.map(async (project) => {
          const tag = getReleaseTag(project.name, project.version);
          const release = await findDraftReleaseByTag(
            options.githubToken,
            options.owner,
            options.repo,
            tag
          );
          return {
            name: project.name,
            version: project.version,
            url: release?.html_url || `https://github.com/${options.owner}/${options.repo}/releases/tag/${tag}`,
            tag,
          };
        })
      );

      await postPRReleaseComment(
        options.githubToken,
        options.owner,
        options.repo,
        options.prNumber,
        releaseLinks
      );
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
  projectVersion: string
): Promise<ProjectPublishResult> {
  const result: ProjectPublishResult = {
    project: descriptor.project,
    success: true,
    published: [],
    verified: [],
  };

  try {
    for (const artifact of descriptor.artifacts) {
      const registries = getArtifactRegistries(artifact);

      for (const registryId of registries) {
        const registry = getRegistry(registryConfig, registryId);
        const token = getToken(registry);

        // Skip if already published
        const artifactName = getArtifactName(artifact);
        const artifactVersion = getArtifactVersion(artifact, projectVersion);

        const verification = await verifyPublication(artifactName, artifactVersion, registry, token);

        if (verification.published) {
          console.log(
            `  ⏭️  Skipping ${artifact.name} - already published to ${registryId}`
          );
          continue;
        }

        // Publish to registry
        console.log(`  🚀 Publishing ${artifact.name} to ${registryId}...`);
        await publishArtifact(artifact, registry, descriptor, workspaceRoot);

        // Verify publication
        const postVerification = await verifyPublication(artifactName, artifactVersion, registry, token);

        if (!postVerification.published) {
          throw new Error(
            `Verification failed for ${artifact.name} in ${registryId}: ${postVerification.error}`
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

/**
 * Publish single artifact to a registry
 */
async function publishArtifact(
  artifact: Artifact,
  registry: Registry,
  descriptor: ProjectArtifactDescriptor,
  workspaceRoot: string
): Promise<void> {
  const token = getToken(registry);

  switch (artifact.type) {
    case 'npm':
      if (!artifact.path) {
        throw new Error(`NPM artifact ${artifact.name} missing path`);
      }
      // Use just the filename from the artifact path and look in .artifacts/
      await publishToNpm({
        artifactPath: join(workspaceRoot, '.artifacts', basename(artifact.path)),
        registry: registry as NpmRegistry,
        token,
      });
      break;

    case 'nuget':
      if (!artifact.path) {
        throw new Error(`NuGet artifact ${artifact.name} missing path`);
      }
      // Use just the filename from the artifact path and look in .artifacts/
      await publishToNuget({
        artifactPath: join(workspaceRoot, '.artifacts', basename(artifact.path)),
        registry: registry as NugetRegistry,
        apiKey: token,
      });
      break;

    case 'docker':
      {
        const dockerRegistry = registry as DockerRegistry;
        if (!artifact.tempTag || !artifact.finalTag || !artifact.digest) {
          throw new Error(`Docker artifact ${artifact.name} missing required fields`);
        }

        const username = dockerRegistry.usernameEnv
          ? process.env[dockerRegistry.usernameEnv]
          : undefined;

        await publishToDocker({
          imageName: artifact.name,
          tempTag: artifact.tempTag,
          finalTag: artifact.finalTag,
          digest: artifact.digest,
          registry: dockerRegistry,
          username,
          token,
        });
      }
      break;

    case 'release-attachment':
      // Release attachments are already in GitHub Release
      // No external publishing needed
      console.log(`  ℹ️  ${artifact.name} is a release attachment, no external publishing needed`);
      break;

    default:
      throw new Error(`Unknown artifact type: ${(artifact as unknown as { type: string }).type}`);
  }
}

/**
 * Get registries for an artifact (from artifact or default from project)
 */
function getArtifactRegistries(artifact: Artifact): string[] {
  if ('registries' in artifact && Array.isArray(artifact.registries)) {
    return artifact.registries;
  }

  if ('registry' in artifact && typeof artifact.registry === 'string') {
    return [artifact.registry];
  }

  return [];
}

/**
 * Get artifact name for verification
 */
function getArtifactName(artifact: Artifact): string {
  return artifact.name;
}

/**
 * Get artifact version for verification
 */
function getArtifactVersion(artifact: Artifact, projectVersion: string): string {
  // Docker uses tags, not versions
  if (artifact.type === 'docker' && artifact.finalTag) {
    return artifact.finalTag;
  }

  return projectVersion;
}
