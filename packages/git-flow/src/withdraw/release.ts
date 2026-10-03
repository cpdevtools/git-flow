/**
 * GitHub release lookups and the marker writes for withdrawals.
 */

import { getOctokit } from '@actions/github';
import { parseReleaseTag } from '../build-pack/github.js';
import { readWithdrawal, restoredTitle, setWithdrawalInBody, withdrawnTitle } from './metadata.js';
import type { Withdrawal } from './types.js';

export interface ReleaseSummary {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  html_url: string;
  assets: { id: number; name: string }[];
}

type OctokitRelease = {
  id: number;
  tag_name: string;
  name: string | null;
  body?: string | null;
  draft: boolean;
  html_url: string;
  assets: { id: number; name: string }[];
};

function summarize(r: OctokitRelease): ReleaseSummary {
  return {
    id: r.id,
    tag_name: r.tag_name,
    name: r.name,
    body: r.body ?? null,
    draft: r.draft,
    html_url: r.html_url,
    assets: r.assets.map((a) => ({ id: a.id, name: a.name })),
  };
}

export async function getRelease(
  token: string,
  owner: string,
  repo: string,
  releaseId: number,
): Promise<ReleaseSummary> {
  const { data } = await getOctokit(token).rest.repos.getRelease({
    owner,
    repo,
    release_id: releaseId,
  });
  return summarize(data as OctokitRelease);
}

/** The release behind a `{name}/v{version}` tag, or undefined. */
export async function findReleaseByTag(
  token: string,
  owner: string,
  repo: string,
  tag: string,
): Promise<ReleaseSummary | undefined> {
  try {
    const { data } = await getOctokit(token).rest.repos.getReleaseByTag({ owner, repo, tag });
    return summarize(data as OctokitRelease);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return undefined;
    throw err;
  }
}

/** Every published (non-draft) release of one project, newest first. */
export async function listProjectReleases(
  token: string,
  owner: string,
  repo: string,
  projectName: string,
): Promise<ReleaseSummary[]> {
  const octokit = getOctokit(token);
  const all = await octokit.paginate(octokit.rest.repos.listReleases, {
    owner,
    repo,
    per_page: 100,
  });
  return (all as OctokitRelease[])
    .filter((r) => !r.draft && parseReleaseTag(r.tag_name)?.name === projectName)
    .map(summarize);
}

/**
 * Versions of a project that are withdrawn. The floating-tag computation
 * excludes these, both when withdrawing and when publishing a new release.
 */
export async function listWithdrawnVersions(
  token: string,
  owner: string,
  repo: string,
  projectName: string,
): Promise<string[]> {
  const releases = await listProjectReleases(token, owner, repo, projectName);
  return releases
    .filter((r) => readWithdrawal(r.body))
    .map((r) => parseReleaseTag(r.tag_name)!.version);
}

/** Write the marker, banner and title prefix. Returns the updated release. */
export async function markReleaseWithdrawn(
  token: string,
  owner: string,
  repo: string,
  release: ReleaseSummary,
  withdrawal: Withdrawal,
): Promise<ReleaseSummary> {
  const body = setWithdrawalInBody(release.body ?? '', withdrawal);
  const { data } = await getOctokit(token).rest.repos.updateRelease({
    owner,
    repo,
    release_id: release.id,
    body,
    name: withdrawnTitle(release.name ?? release.tag_name),
  });
  return summarize(data as OctokitRelease);
}

/** Remove the marker, banner and title prefix. Returns the updated release. */
export async function clearReleaseWithdrawn(
  token: string,
  owner: string,
  repo: string,
  release: ReleaseSummary,
): Promise<ReleaseSummary> {
  const body = setWithdrawalInBody(release.body ?? '', null);
  const { data } = await getOctokit(token).rest.repos.updateRelease({
    owner,
    repo,
    release_id: release.id,
    body,
    name: restoredTitle(release.name ?? release.tag_name),
  });
  return summarize(data as OctokitRelease);
}

/** Delete every asset attached to the release. Returns the names removed. */
export async function deleteReleaseAssets(
  token: string,
  owner: string,
  repo: string,
  release: ReleaseSummary,
): Promise<string[]> {
  const octokit = getOctokit(token);
  const removed: string[] = [];
  for (const asset of release.assets) {
    await octokit.rest.repos.deleteReleaseAsset({ owner, repo, asset_id: asset.id });
    removed.push(asset.name);
  }
  return removed;
}
