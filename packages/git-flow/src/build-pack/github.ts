/**
 * GitHub API operations for draft releases and artifact uploads
 */

import { getOctokit } from '@actions/github';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseDocument } from 'yaml';
import type { BuildPackContext, ProjectConfig } from './types.js';

/**
 * Add published:false to all artifacts in YAML metadata
 */
function addPublishedFlagsToMetadata(artifactYaml: string): string {
  const doc = parseDocument(artifactYaml);

  // Add published:false to each artifact
  const artifacts = doc.get('artifacts') as any;
  if (artifacts && Array.isArray(artifacts.items)) {
    for (const artifactNode of artifacts.items) {
      if (
        artifactNode &&
        typeof artifactNode.set === 'function' &&
        !artifactNode.has('published')
      ) {
        artifactNode.set('published', false);
      }
    }
  }

  return doc.toString();
}

/**
 * Get release tag name for a project
 */
export function getReleaseTag(projectName: string, version: string): string {
  return `v${version}/${projectName}`;
}

/**
 * Find existing draft release by tag
 */
export async function findDraftReleaseByTag(
  githubToken: string,
  owner: string,
  repo: string,
  tag: string,
): Promise<{
  id: number;
  upload_url: string;
  html_url: string;
  body: string | null | undefined;
} | null> {
  const octokit = getOctokit(githubToken);

  try {
    const { data: releases } = await octokit.rest.repos.listReleases({
      owner,
      repo,
      per_page: 100,
    });

    // Parse tag to get name and version for fallback search
    // Tag format: vX.Y.Z/@scope/name -> name: "@scope/name X.Y.Z"
    const tagMatch = tag.match(/^v([^/]+)\/(.+)$/);
    const expectedName = tagMatch ? `${tagMatch[2]} ${tagMatch[1]}` : null;

    // First try to find by exact tag match
    let draftRelease = releases.find((r) => r.tag_name === tag && r.draft);

    // Fallback: find by release name (handles GitHub's untagged- behavior)
    if (!draftRelease && expectedName) {
      draftRelease = releases.find((r) => r.name === expectedName && r.draft);
    }

    if (draftRelease) {
      return {
        id: draftRelease.id,
        upload_url: draftRelease.upload_url,
        html_url: draftRelease.html_url,
        body: draftRelease.body,
      };
    }

    return null;
  } catch (error) {
    console.error(`Error finding draft release ${tag}:`, error);
    return null;
  }
}

/**
 * Create a new draft release
 */
export async function createDraftRelease(
  githubToken: string,
  owner: string,
  repo: string,
  tag: string,
  name: string,
  body: string,
  prerelease: boolean,
  sha: string,
): Promise<{ id: number; upload_url: string }> {
  const octokit = getOctokit(githubToken);

  const { data: release } = await octokit.rest.repos.createRelease({
    owner,
    repo,
    tag_name: tag,
    name,
    body,
    draft: true,
    prerelease,
    target_commitish: sha,
  });

  return {
    id: release.id,
    upload_url: release.upload_url,
  };
}

/**
 * Update draft release body
 */
export async function updateDraftReleaseBody(
  githubToken: string,
  owner: string,
  repo: string,
  releaseId: number,
  body: string,
): Promise<void> {
  const octokit = getOctokit(githubToken);

  await octokit.rest.repos.updateRelease({
    owner,
    repo,
    release_id: releaseId,
    body,
  });
}

/**
 * Find or create draft release for a project
 */
export async function findOrCreateDraftRelease(
  project: ProjectConfig,
  context: BuildPackContext,
  artifactMetadata?: string,
): Promise<{ id: number; upload_url: string }> {
  // Extract owner/repo from GitHub context (would come from environment in real action)
  // For now, using placeholders
  const owner = process.env.GITHUB_REPOSITORY_OWNER || 'cpdevtools';
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'unknown';

  const tag = getReleaseTag(project.name, project.version);
  const name = `${project.name} ${project.version}`;

  // Calculate all tags that will be created
  const versionGroup = project.placeholder.split('-')[1] || 'MAIN';
  const tags = [
    tag, // Package-specific tag (e.g., v0.2.1/@cpdevtools/git-flow)
    `v${project.version}/${versionGroup}`, // Version group tag (e.g., v0.2.1/MAIN)
  ];
  // Add simple version tag for MAIN group only
  if (versionGroup === 'MAIN') {
    tags.push(`v${project.version}`); // Simple version tag (e.g., v0.2.1)
  }

  // Add published:false to artifact metadata if provided
  const processedMetadata = artifactMetadata
    ? addPublishedFlagsToMetadata(artifactMetadata)
    : undefined;

  // Build release body with PR link, tags, and artifact metadata
  const prLink = `📋 **Created from PR:** #${context.prNumber}`;
  const tagsList = tags.map((t) => `- \`${t}\``).join('\n');
  const tagsSection = `\n\n🏷️ **Tags:**\n${tagsList}`;
  const artifactSection = processedMetadata
    ? `\n\n## Artifact Metadata\n\`\`\`yaml\n${processedMetadata}\n\`\`\``
    : '';
  const body = `${prLink}${tagsSection}${artifactSection}`;

  // Try to find existing draft release
  const existing = await findDraftReleaseByTag(context.githubToken, owner, repo, tag);

  if (existing) {
    console.log(`  ✓ Found existing draft release: ${tag}`);

    // Always update release body with PR link, tags, and artifact metadata
    await updateDraftReleaseBody(context.githubToken, owner, repo, existing.id, body);

    return existing;
  }

  // Create new draft release
  console.log(`  📝 Creating draft release: ${tag}`);
  return createDraftRelease(
    context.githubToken,
    owner,
    repo,
    tag,
    name,
    body,
    project.prerelease,
    context.sha,
  );
}

/**
 * Check if artifact already exists in release
 */
export async function isArtifactUploaded(
  githubToken: string,
  owner: string,
  repo: string,
  releaseId: number,
  assetName: string,
): Promise<boolean> {
  const octokit = getOctokit(githubToken);

  try {
    const { data: assets } = await octokit.rest.repos.listReleaseAssets({
      owner,
      repo,
      release_id: releaseId,
    });

    return assets.some((asset) => asset.name === assetName);
  } catch (error) {
    console.error(`Error checking for asset ${assetName}:`, error);
    return false;
  }
}

/**
 * Upload artifact file to draft release
 */
export async function uploadArtifact(
  githubToken: string,
  owner: string,
  repo: string,
  releaseId: number,
  uploadUrl: string,
  filePath: string,
): Promise<void> {
  const octokit = getOctokit(githubToken);
  const fileName = basename(filePath);

  // Check if already uploaded
  const alreadyExists = await isArtifactUploaded(githubToken, owner, repo, releaseId, fileName);

  if (alreadyExists) {
    console.log(`  ⊘ ${fileName} already uploaded, skipping`);
    return;
  }

  // Read file content
  const fileContent = await readFile(filePath);

  // Determine content type
  const contentType = fileName.endsWith('.yml')
    ? 'application/x-yaml'
    : fileName.endsWith('.tgz')
      ? 'application/gzip'
      : fileName.endsWith('.nupkg')
        ? 'application/octet-stream'
        : 'application/octet-stream';

  console.log(`  ⬆️  Uploading ${fileName}...`);

  await octokit.rest.repos.uploadReleaseAsset({
    owner,
    repo,
    release_id: releaseId,
    name: fileName,
    data: fileContent as unknown as string,
    headers: {
      'content-type': contentType,
      'content-length': fileContent.length,
    },
  });

  console.log(`  ✓ Uploaded ${fileName}`);
}

/**
 * Delete draft release (for "Start fresh" functionality)
 */
export async function deleteDraftRelease(
  githubToken: string,
  owner: string,
  repo: string,
  projectName: string,
  version: string,
): Promise<void> {
  const octokit = getOctokit(githubToken);
  const tag = getReleaseTag(projectName, version);

  try {
    // Find release by tag
    const { data: release } = await octokit.rest.repos.getReleaseByTag({
      owner,
      repo,
      tag,
    });

    if (release && release.draft) {
      // Delete draft release (published releases are protected)
      await octokit.rest.repos.deleteRelease({
        owner,
        repo,
        release_id: release.id,
      });

      console.log(`  🗑️  Deleted draft release: ${tag}`);
    }
  } catch (error: any) {
    if (error.status === 404) {
      // Release doesn't exist, that's fine
      return;
    }
    throw error;
  }
}

/**
 * Detect if draft releases exist for any projects
 */
export async function detectDraftReleases(
  githubToken: string,
  owner: string,
  repo: string,
  projects: Array<{ name: string; version: string }>,
): Promise<boolean> {
  const octokit = getOctokit(githubToken);

  for (const project of projects) {
    const tag = getReleaseTag(project.name, project.version);

    try {
      const { data: release } = await octokit.rest.repos.getReleaseByTag({
        owner,
        repo,
        tag,
      });

      if (release && release.draft) {
        return true; // Found at least one draft
      }
    } catch (error: any) {
      if (error.status !== 404) {
        throw error;
      }
    }
  }

  return false; // No drafts found
}

/**
 * Finalize release (convert draft to published)
 */
export async function finalizeRelease(
  githubToken: string,
  owner: string,
  repo: string,
  projectName: string,
  version: string,
  prerelease: boolean,
): Promise<void> {
  const octokit = getOctokit(githubToken);
  const tag = getReleaseTag(projectName, version);

  try {
    // Find draft release by listing all releases
    const { data: releases } = await octokit.rest.repos.listReleases({
      owner,
      repo,
      per_page: 100,
    });

    // Parse tag to get name for fallback search
    const expectedName = `${projectName} ${version}`;

    // Check if a published release with this tag already exists
    const existingPublished = releases.find((r) => r.tag_name === tag && !r.draft);
    if (existingPublished) {
      console.log(`  ℹ️  Release already published: ${tag} (ID: ${existingPublished.id})`);
      return;
    }

    // First try to find by exact tag match
    let release = releases.find((r) => r.tag_name === tag && r.draft);

    // Fallback: find by release name (handles GitHub's untagged- behavior)
    if (!release) {
      release = releases.find((r) => r.name === expectedName && r.draft);
    }

    if (!release) {
      throw new Error(`Release not found: ${tag}`);
    }

    // Update to published (using prerelease flag from PR metadata)
    // IMPORTANT: Also update tag_name to the final tag
    await octokit.rest.repos.updateRelease({
      owner,
      repo,
      release_id: release.id,
      tag_name: tag, // Update from untagged-XXX to final tag
      draft: false,
      prerelease,
    });

    console.log(`  ✅ Published release: ${tag}`);
  } catch (error: any) {
    if (error.status === 404) {
      throw new Error(`Release not found: ${tag}`);
    }
    throw error;
  }
}

/**
 * Create git tag for released version
 */
export async function createGitTag(
  githubToken: string,
  owner: string,
  repo: string,
  projectName: string,
  version: string,
  sha: string,
  placeholder: string,
): Promise<void> {
  const octokit = getOctokit(githubToken);
  const tag = getReleaseTag(projectName, version);

  // Extract version group from placeholder (e.g., "0.0.0-MAIN" -> "MAIN")
  const versionGroup = placeholder.split('-')[1] || 'MAIN';

  const tagsToCreate = [
    { tag, label: 'package-specific tag' },
    { tag: `v${version}/${versionGroup}`, label: 'version group tag' },
  ];

  // If version group is MAIN, also create simple vX.Y.Z tag
  if (versionGroup === 'MAIN') {
    tagsToCreate.push({ tag: `v${version}`, label: 'simple version tag' });
  }

  for (const { tag: tagName, label } of tagsToCreate) {
    try {
      // Create tag reference
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/tags/${tagName}`,
        sha,
      });

      console.log(`  🏷️  Created ${label}: ${tagName}`);
    } catch (error: any) {
      if (error.status === 422) {
        // Tag already exists
        console.log(`  ✓ ${label} already exists: ${tagName}`);
      } else {
        throw error;
      }
    }
  }
}

/**
 * Get draft release by tag and extract artifact metadata from body
 */
export async function getDraftReleaseMetadata(
  githubToken: string,
  owner: string,
  repo: string,
  tag: string,
): Promise<string | null> {
  const octokit = getOctokit(githubToken);

  try {
    // List all releases and find the draft with matching tag
    // getReleaseByTag doesn't return draft releases
    const { data: releases } = await octokit.rest.repos.listReleases({
      owner,
      repo,
      per_page: 100, // Should be enough for recent releases
    });

    // Parse tag to get name and version for fallback search
    // Tag format: vX.Y.Z/@scope/name -> name: "@scope/name X.Y.Z"
    const tagMatch = tag.match(/^v([^/]+)\/(.+)$/);
    const expectedName = tagMatch ? `${tagMatch[2]} ${tagMatch[1]}` : null;

    // First try to find by exact tag match
    let release = releases.find((r) => r.tag_name === tag && r.draft);

    // Fallback: find by release name (handles GitHub's untagged- behavior)
    if (!release && expectedName) {
      release = releases.find((r) => r.name === expectedName && r.draft);
    }

    if (!release || !release.body) {
      return null;
    }

    // Extract YAML from markdown code block
    const yamlMatch = release.body.match(/```yaml\s*\n([\s\S]*?)\n\s*```/);
    return yamlMatch ? yamlMatch[1] : null;
  } catch (error: any) {
    console.error(`Error getting draft release metadata ${tag}:`, error);
    return null;
  }
}

/**
 * Check whether a finalized (non-draft) release already exists for a tag.
 *
 * Used for idempotent re-runs of publish-release: a project whose release has
 * already been finalized should be skipped rather than treated as a missing
 * draft (which would otherwise fail the run).
 */
export async function isReleasePublished(
  githubToken: string,
  owner: string,
  repo: string,
  tag: string,
): Promise<boolean> {
  const octokit = getOctokit(githubToken);

  try {
    const { data: releases } = await octokit.rest.repos.listReleases({
      owner,
      repo,
      per_page: 100,
    });

    // Tag format: vX.Y.Z/@scope/name -> name: "@scope/name X.Y.Z"
    const tagMatch = tag.match(/^v([^/]+)\/(.+)$/);
    const expectedName = tagMatch ? `${tagMatch[2]} ${tagMatch[1]}` : null;

    return releases.some(
      (r) => !r.draft && (r.tag_name === tag || (expectedName != null && r.name === expectedName)),
    );
  } catch (error) {
    console.error(`Error checking published release ${tag}:`, error);
    return false;
  }
}

/**
 * Post a comment on a PR with links to published releases
 */
export async function postPRReleaseComment(
  githubToken: string,
  owner: string,
  repo: string,
  prNumber: number,
  releases: Array<{ name: string; version: string; url: string; tag: string }>,
): Promise<void> {
  const octokit = getOctokit(githubToken);

  const releaseLinks = releases
    .map((r) => `- **${r.name}** [${r.version}](${r.url}) - \`${r.tag}\``)
    .join('\n');

  const body = `## ✅ Releases Published

${releaseLinks}

All releases have been successfully published and are now available.`;

  try {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });

    console.log(`  ✓ Posted release comment to PR #${prNumber}`);
  } catch (error: any) {
    console.error(`  ⚠️  Failed to post PR comment:`, error.message);
    // Don't throw - this is not critical
  }
}
