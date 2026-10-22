/**
 * GitHub API operations for draft releases and artifact uploads
 */

import { getOctokit } from '@actions/github';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseDocument } from 'yaml';
import type { BuildPackContext, ProjectConfig } from './types.js';
import { setReleaseIdsInPRBody } from './options.js';

/**
 * Add published:false to all artifacts in YAML metadata
 */
function addPublishedFlagsToMetadata(artifactYaml: string): string {
  return setPublishedInMetadata(artifactYaml, false);
}

/**
 * Set published flag on all artifacts in YAML metadata.
 */
function setPublishedInMetadata(artifactYaml: string, value: boolean): string {
  const doc = parseDocument(artifactYaml);

  // Add/update published flag on each artifact
  const artifacts = doc.get('artifacts') as any;
  if (artifacts && Array.isArray(artifacts.items)) {
    for (const artifactNode of artifacts.items) {
      if (artifactNode && typeof artifactNode.set === 'function') {
        artifactNode.set('published', value);
      }
    }
  }

  return doc.toString();
}

/**
 * Record where a release came from as top-level `branch` / `pr` keys, so
 * `gitflow deploy` can map the release back to its source branch without a PR
 * lookup. Keys with no value (manual dispatch has no PR) are left out.
 */
export function addSourceToMetadata(
  artifactYaml: string,
  source: { branch?: string; prNumber?: number },
): string {
  const doc = parseDocument(artifactYaml);
  if (source.branch) doc.set('branch', source.branch);
  if (source.prNumber) doc.set('pr', source.prNumber);
  return doc.toString();
}

/**
 * Get release tag name for a project.
 *
 * The version must be the last path segment: git refs are filesystem paths, so a
 * `v{version}/{name}` layout would make `v{version}` a directory and permanently
 * block the plain `v{version}` tag (and any `v*` alias) in the same repo.
 */
export function getReleaseTag(projectName: string, version: string): string {
  return `${projectName}/v${version}`;
}

/**
 * Every version of a project that has a release tag (`<name>/v<version>`).
 *
 * Read from git refs rather than from a registry: the tags are the one record
 * every registry was published from, and registries drift (GHCR still carries a
 * `next` frozen on a pipeline that no longer exists). Includes `.build.N` and
 * development-branch versions — callers filter by shape.
 */
export async function listProjectVersions(
  githubToken: string,
  owner: string,
  repo: string,
  projectName: string,
): Promise<string[]> {
  const octokit = getOctokit(githubToken);
  // The prefix goes into the URL directly: as a template parameter octokit
  // would encode the `/` inside the project name.
  const refs = await octokit.paginate<{ ref: string }>(
    `GET /repos/${owner}/${repo}/git/matching-refs/tags/${projectName}/v`,
    { per_page: 100 },
  );
  const versions: string[] = [];
  for (const { ref } of refs) {
    const parsed = parseReleaseTag(ref.replace(/^refs\/tags\//, ''));
    if (parsed && parsed.name === projectName) versions.push(parsed.version);
  }
  return versions;
}

/**
 * Permanent web URL for a project's release.
 *
 * Deliberately not the API's `html_url` for a draft: that is
 * `/releases/tag/untagged-<hash>`, which 404s while the release is a draft (no
 * such tag exists yet) and dies for good once publish-release tags it. This URL
 * is wrong only in the window before the release is published, and right
 * forever after — which is the way round that suits a job summary someone reads
 * after the run.
 */
export function getReleaseUrl(
  owner: string,
  repo: string,
  projectName: string,
  version: string,
): string {
  return `https://github.com/${owner}/${repo}/releases/tag/${getReleaseTag(projectName, version)}`;
}

/**
 * Get the version-group tag (e.g. `MAIN/v1.2.3`)
 */
export function getGroupTag(versionGroup: string, version: string): string {
  return `${versionGroup}/v${version}`;
}

/**
 * Parse a release tag into its project name and version.
 * Returns null for tags that aren't in `{name}/v{version}` form.
 */
export function parseReleaseTag(tag: string): { name: string; version: string } | null {
  const match = tag.match(/^(.+)\/v([^/]+)$/);
  return match ? { name: match[1], version: match[2] } : null;
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
    // Tag format: @scope/name/vX.Y.Z -> name: "@scope/name X.Y.Z"
    const parsed = parseReleaseTag(tag);
    const expectedName = parsed ? `${parsed.name} ${parsed.version}` : null;

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
 * The subset of a GitHub release the release phases work with.
 */
export interface ReleaseInfo {
  id: number;
  draft: boolean;
  tag_name: string;
  name: string | null;
  body: string | null | undefined;
  html_url: string;
  upload_url: string;
  assets: Array<{ id: number; name: string; size: number }>;
}

function toReleaseInfo(r: {
  id: number;
  draft: boolean;
  tag_name: string;
  name: string | null;
  body?: string | null;
  html_url: string;
  upload_url: string;
  assets: Array<{ id: number; name: string; size: number }>;
}): ReleaseInfo {
  return {
    id: r.id,
    draft: r.draft,
    tag_name: r.tag_name,
    name: r.name,
    body: r.body,
    html_url: r.html_url,
    upload_url: r.upload_url,
    assets: r.assets.map((a) => ({ id: a.id, name: a.name, size: a.size })),
  };
}

/**
 * Fetch one release by id. Works for drafts (the by-tag endpoint does not) and
 * is the only lookup that does not depend on the release list, which has been
 * seen to omit a draft once the tag it is named after exists. Returns null on
 * 404; any other error propagates with its status.
 */
export async function getReleaseById(
  githubToken: string,
  owner: string,
  repo: string,
  releaseId: number,
): Promise<ReleaseInfo | null> {
  const octokit = getOctokit(githubToken);
  try {
    const { data } = await octokit.rest.repos.getRelease({ owner, repo, release_id: releaseId });
    return toReleaseInfo(data);
  } catch (error: any) {
    if (error?.status === 404) return null;
    throw new Error(
      `GET /releases/${releaseId} failed (${error?.status ?? 'no status'}): ${error?.message ?? error}`,
    );
  }
}

/**
 * Find the release for a tag — draft or published — by id when one is known,
 * else by scanning the release list.
 *
 * The id comes from the release PR (build-pack records it after upload). The
 * list scan is the fallback for PRs built before ids were recorded and for a
 * stale id (the draft was deleted and recreated); it matches the exact tag
 * first, then the release name, because GitHub rewrites a draft's `tag_name`
 * to `untagged-<hash>` in some cases.
 */
export async function resolveRelease(
  githubToken: string,
  owner: string,
  repo: string,
  lookup: { tag: string; releaseId?: number },
): Promise<ReleaseInfo | null> {
  const { tag, releaseId } = lookup;

  if (releaseId !== undefined) {
    const byId = await getReleaseById(githubToken, owner, repo, releaseId);
    if (byId) {
      console.log(`  🔎 Release ${tag}: id ${releaseId} (${byId.draft ? 'draft' : 'published'})`);
      return byId;
    }
    console.log(`  ⚠️  Release id ${releaseId} for ${tag} returned 404; falling back to list scan`);
  }

  const octokit = getOctokit(githubToken);
  const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
    owner,
    repo,
    per_page: 100,
  });

  const parsed = parseReleaseTag(tag);
  const expectedName = parsed ? `${parsed.name} ${parsed.version}` : null;

  const match =
    releases.find((r) => r.tag_name === tag) ??
    (expectedName ? releases.find((r) => r.name === expectedName) : undefined);

  if (!match) return null;
  console.log(
    `  🔎 Release ${tag}: id ${match.id} (${match.draft ? 'draft' : 'published'}, found by list scan)`,
  );
  return toReleaseInfo(match);
}

/**
 * The YAML inside the release body's `## Artifact Metadata` block, or null.
 */
export function extractArtifactMetadataYaml(body: string | null | undefined): string | null {
  if (!body) return null;
  const yamlMatch = body.match(/```yaml\s*\n([\s\S]*?)\n\s*```/);
  return yamlMatch ? yamlMatch[1] : null;
}

/**
 * Download one release asset's bytes.
 */
export async function downloadReleaseAsset(
  githubToken: string,
  owner: string,
  repo: string,
  assetId: number,
): Promise<Buffer> {
  const octokit = getOctokit(githubToken);
  const response = await octokit.rest.repos.getReleaseAsset({
    owner,
    repo,
    asset_id: assetId,
    headers: { accept: 'application/octet-stream' },
  });
  return Buffer.from(response.data as unknown as ArrayBuffer);
}

/**
 * Record each project's draft release id in the release PR body so
 * publish-release can fetch the release directly. Reads the body fresh and
 * rewrites only the `releaseId:` lines (see setReleaseIdsInPRBody).
 */
export async function recordReleaseIds(
  githubToken: string,
  owner: string,
  repo: string,
  prNumber: number,
  ids: Record<string, number>,
): Promise<void> {
  if (Object.keys(ids).length === 0) return;
  const octokit = getOctokit(githubToken);
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const body = pr.body ?? '';
  const updated = setReleaseIdsInPRBody(body, ids);
  if (updated === body) {
    console.log(`  ℹ️  PR #${prNumber} body already carries the release ids`);
    return;
  }
  await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, body: updated });
  console.log(
    `  📝 Recorded release ids in PR #${prNumber}: ${Object.entries(ids)
      .map(([n, id]) => `${n}=${id}`)
      .join(', ')}`,
  );
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
): Promise<{ id: number; upload_url: string; html_url: string }> {
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
    html_url: release.html_url,
  };
}

/**
 * Mark all artifacts in a release as published:true.
 * Called after all assets are uploaded so the CLI knows the release is fully
 * ready to deploy (not mid-publish).
 */
export async function markReleasePublished(
  githubToken: string,
  owner: string,
  repo: string,
  releaseId: number,
): Promise<void> {
  const octokit = getOctokit(githubToken);
  const { data: release } = await octokit.rest.repos.getRelease({
    owner,
    repo,
    release_id: releaseId,
  });
  if (!release.body) return;

  const yamlMatch = release.body.match(
    /(## Artifact Metadata\s*```yaml\s*\n)([\s\S]*?)(\n\s*```)/m,
  );
  if (!yamlMatch) return;

  const updatedYaml = setPublishedInMetadata(yamlMatch[2], true);
  const updatedBody = release.body.replace(
    /## Artifact Metadata\s*```yaml\s*\n[\s\S]*?\n\s*```/m,
    `## Artifact Metadata\n\`\`\`yaml\n${updatedYaml}\n\`\`\``,
  );
  await updateDraftReleaseBody(githubToken, owner, repo, releaseId, updatedBody);
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
): Promise<{ id: number; upload_url: string; html_url: string }> {
  // Extract owner/repo from GitHub context (would come from environment in real action)
  // For now, using placeholders
  const owner = process.env.GITHUB_REPOSITORY_OWNER || 'cpdevtools';
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'unknown';

  const tag = getReleaseTag(project.name, project.version);
  const name = `${project.name} ${project.version}`;

  // Calculate all tags that will be created
  const versionGroup = project.placeholder.split('-')[1] || 'MAIN';
  const tags = [
    tag, // Package-specific tag (e.g., @cpdevtools/git-flow/v0.2.1)
    getGroupTag(versionGroup, project.version), // Version group tag (e.g., MAIN/v0.2.1)
  ];
  // Add simple version tag for MAIN group only
  if (versionGroup === 'MAIN') {
    tags.push(`v${project.version}`); // Simple version tag (e.g., v0.2.1)
  }

  // Add published:false to artifact metadata if provided
  const processedMetadata = artifactMetadata
    ? addSourceToMetadata(addPublishedFlagsToMetadata(artifactMetadata), context)
    : undefined;

  // Build release body with PR link, tags, and artifact metadata
  const prLink = `📋 **Created from PR:** #${context.prNumber}`;
  const tagsList = tags.map((t) => `- \`${t}\``).join('\n');
  const tagsSection = `\n\n🏷️ **Tags:**\n${tagsList}`;
  const artifactSection = processedMetadata
    ? `\n\n## Artifact Metadata\n\`\`\`yaml\n${processedMetadata}\n\`\`\``
    : '';
  const body = `${prLink}${tagsSection}${artifactSection}`;

  // Try to find the existing draft: by the id the release PR records, else by
  // scanning the list. A published release under this tag means the version
  // already shipped; refuse rather than silently create a duplicate draft.
  const resolved = await resolveRelease(context.githubToken, owner, repo, {
    tag,
    releaseId: project.releaseId,
  });
  if (resolved && !resolved.draft) {
    throw new Error(
      `Release ${tag} is already published (id ${resolved.id}); cannot rebuild a released version`,
    );
  }
  const existing = resolved
    ? { id: resolved.id, upload_url: resolved.upload_url, html_url: resolved.html_url }
    : null;

  if (existing) {
    console.log(`  ✓ Found existing draft release: ${tag} (id ${existing.id})`);

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
  return (await findReleaseAssetId(githubToken, owner, repo, releaseId, assetName)) !== undefined;
}

/**
 * Find the id of a release asset by name, or undefined if absent.
 */
export async function findReleaseAssetId(
  githubToken: string,
  owner: string,
  repo: string,
  releaseId: number,
  assetName: string,
): Promise<number | undefined> {
  const octokit = getOctokit(githubToken);

  try {
    const { data: assets } = await octokit.rest.repos.listReleaseAssets({
      owner,
      repo,
      release_id: releaseId,
    });

    return assets.find((asset) => asset.name === assetName)?.id;
  } catch (error) {
    console.error(`Error checking for asset ${assetName}:`, error);
    return undefined;
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
  assetName?: string,
  options: { label?: string; contentType?: string } = {},
): Promise<void> {
  const octokit = getOctokit(githubToken);
  // The on-disk name can be unique (to avoid collisions in the shared staging
  // dir); assetName overrides the name the asset is published under on the release.
  const fileName = assetName ?? basename(filePath);

  // Replace, never skip: on a resumed draft the artifacts were REBUILT this
  // run (builds are not bit-reproducible — a docker image gets a new id), so a
  // leftover asset from a previous attempt no longer matches the descriptor
  // this run writes into the release body. Skipping here is how a draft ends
  // up with a fresh digest pointing at stale bytes, which publish then fails
  // with "Docker image digest mismatch".
  const staleAssetId = await findReleaseAssetId(githubToken, owner, repo, releaseId, fileName);
  if (staleAssetId !== undefined) {
    console.log(`  ♻️  ${fileName} exists from a previous attempt — replacing`);
    await octokit.rest.repos.deleteReleaseAsset({ owner, repo, asset_id: staleAssetId });
  }

  // Read file content
  const fileContent = await readFile(filePath);

  // Determine content type
  const contentType =
    options.contentType ??
    (fileName.endsWith('.yml')
    ? 'application/x-yaml'
    : fileName.endsWith('.tgz')
      ? 'application/gzip'
      : fileName.endsWith('.zip')
        ? 'application/zip'
        : fileName.endsWith('.nupkg')
          ? 'application/octet-stream'
          : 'application/octet-stream');

  console.log(`  ⬆️  Uploading ${fileName}...`);

  await octokit.rest.repos.uploadReleaseAsset({
    owner,
    repo,
    release_id: releaseId,
    name: fileName,
    ...(options.label ? { label: options.label } : {}),
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
  releaseId?: number,
): Promise<void> {
  const octokit = getOctokit(githubToken);
  const tag = getReleaseTag(projectName, version);

  // Drafts are invisible to the by-tag endpoint, so resolve by id or list scan.
  const release = await resolveRelease(githubToken, owner, repo, { tag, releaseId });
  if (!release) return;
  if (!release.draft) {
    console.log(`  ⏭️  ${tag} is already published (id ${release.id}); not deleting`);
    return;
  }

  await octokit.rest.repos.deleteRelease({ owner, repo, release_id: release.id });
  console.log(`  🗑️  Deleted draft release: ${tag} (id ${release.id})`);
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
  for (const project of projects) {
    const tag = getReleaseTag(project.name, project.version);
    // The by-tag endpoint never returns drafts; scan the list instead.
    const draft = await findDraftReleaseByTag(githubToken, owner, repo, tag);
    if (draft) return true;
  }

  return false; // No drafts found
}

/**
 * Publish a draft release: set the final tag (GitHub creates the git tag at
 * `sha` if it does not exist yet) and clear the draft flag. Errors keep the
 * call, status and release id so the log says which request failed.
 */
export async function finalizeReleaseById(
  githubToken: string,
  owner: string,
  repo: string,
  releaseId: number,
  tag: string,
  sha: string | undefined,
  prerelease: boolean,
): Promise<void> {
  const octokit = getOctokit(githubToken);
  try {
    await octokit.rest.repos.updateRelease({
      owner,
      repo,
      release_id: releaseId,
      tag_name: tag,
      // Where GitHub creates the tag when it does not exist yet. Ignored when
      // the tag already exists (a rerun after an old-style failure).
      ...(sha ? { target_commitish: sha } : {}),
      draft: false,
      prerelease,
    });
    console.log(`  ✅ Published release: ${tag} (id ${releaseId})`);
  } catch (error: any) {
    throw new Error(
      `PATCH /releases/${releaseId} (tag ${tag}, draft → published) failed ` +
        `(${error?.status ?? 'no status'}): ${error?.message ?? error}`,
    );
  }
}

/**
 * Finalize release (convert draft to published), found by list scan.
 *
 * Kept for callers without a release id; the publish phase uses
 * resolveRelease + finalizeReleaseById.
 */
export async function finalizeRelease(
  githubToken: string,
  owner: string,
  repo: string,
  projectName: string,
  version: string,
  prerelease: boolean,
  sha?: string,
): Promise<void> {
  const tag = getReleaseTag(projectName, version);
  const release = await resolveRelease(githubToken, owner, repo, { tag });
  if (!release) {
    throw new Error(`Release not found by list scan: ${tag}`);
  }
  if (!release.draft) {
    console.log(`  ℹ️  Release already published: ${tag} (id ${release.id})`);
    return;
  }
  await finalizeReleaseById(githubToken, owner, repo, release.id, tag, sha, prerelease);
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
    { tag: getGroupTag(versionGroup, version), label: 'version group tag' },
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
    // Tag format: @scope/name/vX.Y.Z -> name: "@scope/name X.Y.Z"
    const parsed = parseReleaseTag(tag);
    const expectedName = parsed ? `${parsed.name} ${parsed.version}` : null;

    // First try to find by exact tag match
    let release = releases.find((r) => r.tag_name === tag && r.draft);

    // Fallback: find by release name (handles GitHub's untagged- behavior)
    if (!release && expectedName) {
      release = releases.find((r) => r.name === expectedName && r.draft);
    }

    return release ? extractArtifactMetadataYaml(release.body) : null;
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

    // Tag format: @scope/name/vX.Y.Z -> name: "@scope/name X.Y.Z"
    const parsed = parseReleaseTag(tag);
    const expectedName = parsed ? `${parsed.name} ${parsed.version}` : null;

    return releases.some(
      (r) => !r.draft && (r.tag_name === tag || (expectedName != null && r.name === expectedName)),
    );
  } catch (error) {
    console.error(`Error checking published release ${tag}:`, error);
    return false;
  }
}

/**
 * Delete draft releases created in a specific run that have no uploaded assets.
 *
 * Called on build failure to clean up empty drafts left behind when a run fails
 * before (or during) the upload phase. Drafts with at least one asset are kept
 * so a subsequent re-run can reuse them.
 */
export async function cleanupEmptyDraftReleases(
  githubToken: string,
  owner: string,
  repo: string,
  runNumber: number,
): Promise<void> {
  const octokit = getOctokit(githubToken);
  const buildSuffix = `.build.${runNumber}`;

  console.log(`🧹 Cleaning up empty draft releases for run ${runNumber}...`);

  let deleted = 0;
  let kept = 0;
  let page = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: releases } = await octokit.rest.repos.listReleases({
      owner,
      repo,
      per_page: 100,
      page,
    });

    if (releases.length === 0) break;

    for (const release of releases) {
      if (!release.draft) continue;
      // GitHub rewrites a draft's tag_name to `untagged-<hash>` in some cases;
      // the release name (`<project> <version>`) still carries the build suffix.
      if (!release.tag_name.includes(buildSuffix) && !(release.name ?? '').includes(buildSuffix)) {
        continue;
      }

      if (release.assets.length === 0) {
        try {
          await octokit.rest.repos.deleteRelease({ owner, repo, release_id: release.id });
          console.log(`  🗑️  Deleted empty draft: ${release.tag_name}`);
          deleted++;
        } catch (err: any) {
          console.warn(`  ⚠️  Failed to delete ${release.tag_name}: ${err.message}`);
        }
      } else {
        console.log(`  ✓ Kept draft with ${release.assets.length} asset(s): ${release.tag_name}`);
        kept++;
      }
    }

    if (releases.length < 100) break;
    page++;
  }

  console.log(`   Cleanup complete: ${deleted} deleted, ${kept} kept`);
}

/**
 * Build the markdown body listing published releases. Shared by the PR comment
 * and the publish-release step summary so both render identically.
 */
export function buildReleaseComment(
  releases: Array<{ name: string; version: string; url: string; tag: string }>,
): string {
  const releaseLinks = releases
    .map((r) => `- **${r.name}** [${r.version}](${r.url}) - \`${r.tag}\``)
    .join('\n');

  return `## ✅ Releases Published

${releaseLinks}

All releases have been successfully published and are now available.`;
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

  const body = buildReleaseComment(releases);

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
