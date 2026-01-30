/**
 * GitHub API operations for draft releases and artifact uploads
 */

import { getOctokit } from '@actions/github';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ProjectConfig, BuildPackContext } from './types.js';

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

    const draftRelease = releases.find((r) => r.tag_name === tag && r.draft);
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
 * Find or create draft release for a project
 */
export async function findOrCreateDraftRelease(
  project: ProjectConfig,
  context: BuildPackContext
): Promise<{ id: number; upload_url: string }> {
  // Extract owner/repo from GitHub context (would come from environment in real action)
  // For now, using placeholders
  const owner = process.env.GITHUB_REPOSITORY_OWNER || 'cpdevtools';
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'unknown';

  const tag = getReleaseTag(project.name, project.version);
  const name = `${project.name} ${project.version}`;
  const body = `Draft release for ${project.name} v${project.version}`;

  // Try to find existing draft release
  const existing = await findDraftReleaseByTag(
    context.githubToken,
    owner,
    repo,
    tag
  );

  if (existing) {
    console.log(`  ✓ Found existing draft release: ${tag}`);
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
