/**
 * Cleanup of stale build artifacts, in four layers:
 *
 *  1. Published `.build.*` releases older than the cutoff — these are throwaway
 *     CI builds that only ever publish to GitHub registries.
 *  2. STALE DRAFT releases older than the cutoff — abandoned in-flight release
 *     attempts (failed packs, superseded versions, GitHub's `untagged-*`
 *     leftovers). Young drafts are never touched: they are the resume state of
 *     a release still in progress.
 *  3. Every git tag belonging to a deleted release — the release's own
 *     tag_name plus the group/simple tags listed in its body (`MAIN/vX`, `vX`).
 *  4. The registry versions the deleted releases published: npm, nuget and
 *     container (ghcr) package versions, resolved from each release body's
 *     Artifact Metadata YAML.
 *
 * The previous implementation was bash+jq under pipefail: a draft's null
 * publishedAt or a 404 error object from the packages API killed the whole run
 * (observed as repeated scheduled-cleanup failures). Here every item is
 * processed independently; individual failures are logged and counted, and
 * only a failure to LIST releases fails the action.
 */
import * as core from '@actions/core';
import { parse as parseYaml } from 'yaml';

const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';
const repo = process.env['GITHUB_REPOSITORY'] ?? '';
const owner = process.env['GITHUB_REPOSITORY_OWNER'] ?? '';
const daysOld = Number(process.env['DAYS_OLD'] || '14');
const dryRun = (process.env['DRY_RUN'] || 'false') === 'true';

if (!token || !repo || !owner) {
  core.setFailed('Missing GH_TOKEN / GITHUB_REPOSITORY / GITHUB_REPOSITORY_OWNER');
  process.exit(1);
}

const API = 'https://api.github.com';

async function gh(
  path: string,
  init: { method?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  let body: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

async function ghPaginate<T>(path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const { status, body } = await gh(`${path}${sep}per_page=100&page=${page}`);
    if (status !== 200 || !Array.isArray(body)) {
      if (all.length === 0 && status !== 404) {
        throw new Error(`GET ${path} page ${page} returned ${status}`);
      }
      return all;
    }
    all.push(...(body as T[]));
    if ((body as T[]).length < 100) return all;
  }
}

interface Release {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
}

interface ReleaseArtifact {
  type: string;
  name: string;
}

/** Artifact list from a release body's `## Artifact Metadata` yaml block. */
function parseArtifacts(body: string | null): ReleaseArtifact[] {
  const yamlMatch = body?.match(/```yaml\s*\n([\s\S]*?)\n\s*```/);
  if (!yamlMatch) return [];
  try {
    const doc = parseYaml(yamlMatch[1]) as { artifacts?: { type?: string; name?: string }[] };
    return (doc?.artifacts ?? [])
      .filter((a) => typeof a?.type === 'string' && typeof a?.name === 'string')
      .map((a) => ({ type: a.type as string, name: a.name as string }));
  } catch {
    return [];
  }
}

/** Every tag a release owns: its tag_name plus the body's `**Tags:**` list. */
function releaseTags(release: Release): string[] {
  const tags = new Set<string>();
  if (release.tag_name && !release.tag_name.startsWith('untagged-')) {
    tags.add(release.tag_name);
  }
  for (const match of (release.body ?? '').matchAll(/^- `([^`]+)`$/gm)) {
    tags.add(match[1]);
  }
  return [...tags];
}

/** The version a release publishes, from its tag ({pkg}/v{ver}) or its name. */
function releaseVersion(release: Release): string | null {
  const fromTag = release.tag_name?.match(/\/v([^/]+)$/)?.[1];
  if (fromTag) return fromTag;
  // Draft names look like "@scope/project 1.2.3-alpha.0".
  const fromName = release.name?.trim().split(/\s+/).pop();
  return fromName && /^\d/.test(fromName) ? fromName : null;
}

/** GitHub Packages type + name for an artifact declaration. */
function packageRef(artifact: ReleaseArtifact): { type: string; name: string } | null {
  switch (artifact.type) {
    case 'npm':
    case 'ng-lib':
      return { type: 'npm', name: artifact.name.replace(/^@[^/]+\//, '') };
    case 'nuget':
    case 'dotnet-lib':
      return { type: 'nuget', name: artifact.name };
    case 'docker':
    case 'docker-image':
      // Bare image name; strip any legacy registry/namespace prefix.
      return { type: 'container', name: artifact.name.split('/').pop() ?? artifact.name };
    default:
      return null; // deploy bundles, release attachments, docker-service: nothing in a registry
  }
}

interface PackageVersion {
  id: number;
  name: string;
  created_at: string;
  metadata?: { container?: { tags?: string[] } };
}

const counts = { releases: 0, tags: 0, versions: 0, failures: 0 };

async function deleteTag(tag: string): Promise<void> {
  const label = `tag ${tag}`;
  if (dryRun) {
    core.info(`  [DRY RUN] would delete ${label}`);
    return;
  }
  const { status } = await gh(`/repos/${repo}/git/refs/tags/${encodeURIComponent(tag)}`, {
    method: 'DELETE',
  });
  if (status === 204) {
    core.info(`  🗑️  deleted ${label}`);
    counts.tags++;
  } else if (status !== 404 && status !== 422) {
    core.warning(`  failed to delete ${label}: HTTP ${status}`);
    counts.failures++;
  }
}

async function deletePackageVersion(
  pkg: { type: string; name: string },
  version: string,
): Promise<void> {
  const base = `/orgs/${owner}/packages/${pkg.type}/${encodeURIComponent(pkg.name)}`;
  let versions: PackageVersion[];
  try {
    versions = await ghPaginate<PackageVersion>(`${base}/versions`);
  } catch {
    return; // package unreadable — not fatal
  }

  const match = versions.find((v) =>
    pkg.type === 'container'
      ? (v.metadata?.container?.tags ?? []).includes(version)
      : v.name === version,
  );
  if (!match) return;

  const label = `${pkg.type} ${pkg.name}@${version}`;
  if (dryRun) {
    core.info(`  [DRY RUN] would delete ${label}`);
    return;
  }
  const { status, body } = await gh(`${base}/versions/${match.id}`, { method: 'DELETE' });
  if (status === 204) {
    core.info(`  🗑️  deleted ${label}`);
    counts.versions++;
  } else if (status === 400 && String(JSON.stringify(body)).includes('last version')) {
    // GitHub refuses to delete a package's last remaining version; deleting the
    // whole package is a bigger decision than a scheduled cleanup should make.
    core.info(`  ⏭️  kept ${label}: it is the package's only version`);
  } else {
    core.warning(`  failed to delete ${label}: HTTP ${status}`);
    counts.failures++;
  }
}

async function deleteRelease(release: Release, reason: string): Promise<void> {
  const title = release.name ?? release.tag_name;
  core.info(`▸ ${dryRun ? '[DRY RUN] would delete' : 'deleting'} ${reason}: ${title}`);

  const version = releaseVersion(release);
  const artifacts = parseArtifacts(release.body);

  if (!dryRun) {
    const { status } = await gh(`/repos/${repo}/releases/${release.id}`, { method: 'DELETE' });
    if (status !== 204) {
      core.warning(`  failed to delete release ${title}: HTTP ${status}`);
      counts.failures++;
      return; // keep its tags/packages if the release itself survived
    }
    counts.releases++;
  }

  for (const tag of releaseTags(release)) {
    await deleteTag(tag);
  }

  if (version) {
    for (const artifact of artifacts) {
      const pkg = packageRef(artifact);
      if (pkg) await deletePackageVersion(pkg, version);
    }
  }
}

async function run(): Promise<void> {
  const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  core.info(`🧹 Cleaning ${repo}: build releases & stale drafts older than ${daysOld} days`);
  if (dryRun) core.info('   DRY RUN — nothing will be deleted');

  const releases = await ghPaginate<Release>(`/repos/${repo}/releases`);
  core.info(`   ${releases.length} releases found`);

  for (const release of releases) {
    const stamp = Date.parse(release.published_at ?? release.created_at);

    if (release.draft) {
      // A young draft is the resume state of an in-flight release — never touch.
      if (Date.parse(release.created_at) < cutoff) {
        await deleteRelease(release, 'stale draft');
      }
      continue;
    }

    if (release.tag_name.includes('.build.') && stamp < cutoff) {
      await deleteRelease(release, 'old build release');
    }
  }

  core.info('');
  core.info(
    `✅ Cleanup complete: ${counts.releases} releases, ${counts.tags} tags, ` +
      `${counts.versions} package versions${dryRun ? ' (dry run: 0 actual deletions)' : ''}`,
  );
  if (counts.failures > 0) {
    core.warning(`${counts.failures} individual deletions failed — see log; not failing the run.`);
  }
}

run().catch((err: unknown) => {
  core.setFailed(String(err));
});
