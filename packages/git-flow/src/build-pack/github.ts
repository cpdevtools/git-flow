/**
 * GitHub API operations for draft releases and artifact uploads
 */

import { getOctokit } from '@actions/github';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseDocument } from 'yaml';
import type { ProjectConfig, BuildPackContext } from './types.js';
import type { ProjectArtifactDescriptor } from '@cpdevtools/ts-dev-utilities/artifacts';

/**
 * Add published:false to all artifacts in YAML metadata
 */
function addPublishedFlagsToMetadata(artifactYaml: string): string {
  const doc = parseDocument(artifactYaml);
  
  // Add published:false to each artifact
  const artifacts = doc.get('artifacts') as any;
  if (artifacts && Array.isArray(artifacts.items)) {
    for (const artifactNode of artifacts.items) {
      if (artifactNode && typeof artifactNode.set === 'function' && !artifactNode.has('published')) {
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
  return `${projectName}/v${version}`;
}

/**
 * Find existing draft release by tag
 */
export async function findDraftReleaseByTag(
  githubToken: string,
  owner: string,
  repo: string,
  tag: string
): Promise<{ id: number; upload_url: string } | null> {
  const octokit = getOctokit(githubToken);

  try {
    const { data: releases } = await octokit.rest.repos.listReleases({
      owner,
      repo,
      per_page: 100,
    });

    // Parse tag to get name and version for fallback search
    // Tag format: @scope/name/vX.Y.Z -> name: "@scope/name X.Y.Z"
    const tagMatch = tag.match(/^(.+)\/v(.+)$/);
    const expectedName = tagMatch ? `${tagMatch[1]} ${tagMatch[2]}` : null;

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
  sha: string
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
  body: string
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
  artifactMetadata?: string
): Promise<{ id: number; upload_url: string }> {
  // Extract owner/repo from GitHub context (would come from environment in real action)
  // For now, using placeholders
  const owner = process.env.GITHUB_REPOSITORY_OWNER || 'cpdevtools';
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'unknown';

  const tag = getReleaseTag(project.name, project.version);
  const name = `${project.name} ${project.version}`;
  
  // Add published:false to artifact metadata if provided
  const processedMetadata = artifactMetadata ? addPublishedFlagsToMetadata(artifactMetadata) : undefined;
  
  // Include artifact metadata in release body if provided
  const body = processedMetadata 
    ? `## Artifact Metadata\n\`\`\`yaml\n${processedMetadata}\n\`\`\``
    : `Draft release for ${project.name} v${project.version}`;

  // Try to find existing draft release
  const existing = await findDraftReleaseByTag(
    context.githubToken,
    owner,
    repo,
    tag
  );

  if (existing) {
    console.log(`  ✓ Found existing draft release: ${tag}`);
    
    // Update release body with artifact metadata if provided
    if (processedMetadata) {
      await updateDraftReleaseBody(
        context.githubToken,
        owner,
        repo,
        existing.id,
        body
      );
    }
    
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
    context.sha
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
  assetName: string
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
  filePath: string
): Promise<void> {
  const octokit = getOctokit(githubToken);
  const fileName = basename(filePath);

  // Check if already uploaded
  const alreadyExists = await isArtifactUploaded(
    githubToken,
    owner,
    repo,
    releaseId,
    fileName
  );

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
  version: string
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
  projects: Array<{ name: string; version: string }>
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
  prerelease: boolean
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
    await octokit.rest.repos.updateRelease({
      owner,
      repo,
      release_id: release.id,
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
  sha: string
): Promise<void> {
  const octokit = getOctokit(githubToken);
  const tag = getReleaseTag(projectName, version);

  try {
    // Create tag reference
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/tags/${tag}`,
      sha,
    });

    console.log(`  🏷️  Created git tag: ${tag}`);
  } catch (error: any) {
    if (error.status === 422) {
      // Tag already exists
      console.log(`  ✓ Git tag already exists: ${tag}`);
      return;
    }
    throw error;
  }
}

/**
 * Get draft release by tag and extract artifact metadata from body
 */
export async function getDraftReleaseMetadata(
  githubToken: string,
  owner: string,
  repo: string,
  tag: string
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
    // Tag format: @scope/name/vX.Y.Z -> name: "@scope/name X.Y.Z"
    const tagMatch = tag.match(/^(.+)\/v(.+)$/);
    const expectedName = tagMatch ? `${tagMatch[1]} ${tagMatch[2]}` : null;

    // First try to find by exact tag match
    let release = releases.find(r => r.tag_name === tag && r.draft);

    // Fallback: find by release name (handles GitHub's untagged- behavior)
    if (!release && expectedName) {
      release = releases.find(r => r.name === expectedName && r.draft);
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

