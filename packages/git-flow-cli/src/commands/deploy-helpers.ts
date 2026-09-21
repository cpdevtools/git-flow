/**
 * Pure utility functions for the `gitflow deploy` command.
 * Extracted here so they can be imported and unit-tested independently.
 */

import { CHANNEL_ORDER, sanitizeBranchName } from '@cpdevtools/git-flow/version';
import type prompts from 'prompts';
import * as semver from 'semver';
import { parse as parseYaml } from 'yaml';

// ─── types ────────────────────────────────────────────────────────────────────

export interface GHRelease {
  id: number;
  tag_name: string;
  name: string;
  draft: boolean;
  target_commitish: string;
  created_at: string;
  assets: { name: string }[];
  /** Full release body (markdown). Carries the `## Artifact Metadata` YAML block. */
  body?: string | null;
}

/** Minimal shape of an artifact entry in the release-body Artifact Metadata. */
interface MetadataArtifact {
  type?: string;
  name?: string;
  /** Deploy methods this artifact produces bundles for (e.g. ['node', 'compose']). */
  deploy?: string[];
}

/** Minimal shape of the release-body Artifact Metadata descriptor. */
interface MetadataDescriptor {
  project?: string;
  /** Source branch the release was cut from (written by build-pack; absent on older releases). */
  branch?: string;
  /** Release PR number (written by build-pack; absent on older releases). */
  pr?: number;
  artifacts?: MetadataArtifact[];
}

// ─── tag helpers ──────────────────────────────────────────────────────────────

/** Extract the semver string from a gitflow tag (e.g. `@org/pkg/v1.2.3` → `1.2.3`). */
export function versionFromTag(tag: string): string {
  return tag.match(/\/v([^/]+)$/)?.[1] ?? tag;
}

/** Extract the package name from a gitflow tag (e.g. `@org/pkg/v1.2.3` → `@org/pkg`). */
export function packageFromTag(tag: string): string | undefined {
  return tag.match(/^(.+)\/v[^/]+$/)?.[1];
}

/** True for a `{name}/v{semver}` tag — the only layout the deploy flow can select from. */
export function isGitflowTag(tag: string): boolean {
  return packageFromTag(tag) !== undefined && semver.valid(versionFromTag(tag)) !== null;
}

/** Parse a GitHub repo slug from a git remote URL (https or ssh). */
export function parseRepoFromUrl(remoteUrl: string): string {
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot determine GitHub repo from remote URL: ${remoteUrl}`);
  return match[1];
}

// ─── version helpers ──────────────────────────────────────────────────────────

/** True when the release's tag carries a semver pre-release (e.g. `1.2.3-alpha.0`). */
export function isPrerelease(release: GHRelease): boolean {
  return semver.prerelease(versionFromTag(release.tag_name)) !== null;
}

/**
 * Extract the major version pinned by a versioned release branch.
 * Recognizes the git-flow versioned-branch convention where the branch's final
 * segment is `v<major>` (e.g. `release/v0`, `v1`). Returns the major as a
 * number, or `null` when the branch isn't versioned (e.g. `release/main`).
 */
export function majorFromVersionBranch(branch: string): number | null {
  const m = branch.match(/(?:^|\/)v(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Keep only releases whose semver major matches `major`. */
export function filterReleasesByMajor(releases: GHRelease[], major: number): GHRelease[] {
  return releases.filter((r) => {
    const v = versionFromTag(r.tag_name);
    return semver.valid(v) ? semver.major(v) === major : false;
  });
}

/** Keep only releases advertising at least one of `allowed`. Empty `allowed` = no restriction. */
export function filterReleasesByMethods(releases: GHRelease[], allowed: string[]): GHRelease[] {
  if (allowed.length === 0) return releases;
  return releases.filter((r) => releaseDeployMethods(r).some((m) => allowed.includes(m)));
}

// ─── source branch mapping ────────────────────────────────────────────────────

const RELEASE_PREFIX = 'release/';

/** Strip the `release/` prefix (`release/feature/x` → `feature/x`). */
export function stripReleasePrefix(branch: string): string {
  return branch.startsWith(RELEASE_PREFIX) ? branch.slice(RELEASE_PREFIX.length) : branch;
}

/** Source branch recorded in the release's Artifact Metadata, if any. */
export function branchFromMetadata(release: GHRelease): string | undefined {
  const branch = extractArtifactMetadata(release.body)?.branch;
  return typeof branch === 'string' && branch.trim() ? branch.trim() : undefined;
}

/** Release PR number from the body's `Created from PR: #N` line (or metadata `pr`). */
export function prNumberFromBody(body: string | null | undefined): number | undefined {
  if (!body) return undefined;
  const pr = extractArtifactMetadata(body)?.pr;
  if (typeof pr === 'number' && pr > 0) return pr;
  const m = body.match(/Created from PR:\**\s*#(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/**
 * Sanitized source-branch key embedded in a version's pre-release, i.e. what is
 * left after dropping the trailing `build.<n>` and `<channel>[.<n>]` parts.
 * `3.0.0-erd.wire-cut.alpha.1.build.99` → `erd.wire-cut`; `3.0.0-alpha.2` and
 * `3.0.0` → `''` (mainline).
 */
export function branchKeyFromVersion(version: string): string {
  const ids = [...(semver.prerelease(version) ?? [])];
  const isChannel = (id: string | number | undefined): boolean =>
    typeof id === 'string' && (CHANNEL_ORDER as readonly string[]).includes(id.toLowerCase());

  if (
    ids.length >= 2 &&
    ids[ids.length - 2] === 'build' &&
    typeof ids[ids.length - 1] === 'number'
  ) {
    ids.splice(-2);
  }
  if (
    ids.length >= 2 &&
    isChannel(ids[ids.length - 2]) &&
    typeof ids[ids.length - 1] === 'number'
  ) {
    ids.splice(-2);
  } else if (isChannel(ids[ids.length - 1])) {
    ids.pop();
  }
  return ids.join('.');
}

/**
 * Map a sanitized branch key back to a branch name. Sanitizing is lossy (`/` and
 * other characters all become `.`), so match forward against the remote branches
 * instead of inverting; a key with no match is a deleted branch and gets a
 * best-effort dots→slashes name. A mainline key (`''`) is `v<major>` when that
 * versioned branch exists, else the default branch.
 */
export function branchFromKey(
  key: string,
  major: number,
  remoteBranches: string[],
  defaultBranch: string,
): string {
  if (key === '') {
    const versioned = `v${major}`;
    return remoteBranches.includes(versioned) || remoteBranches.includes(RELEASE_PREFIX + versioned)
      ? versioned
      : defaultBranch;
  }
  const sources = [...new Set(remoteBranches.map(stripReleasePrefix))];
  return sources.find((b) => sanitizeBranchName(b) === key) ?? key.replace(/\./g, '/');
}

/**
 * Source branch of a release: metadata `branch` → release PR head (`prHeads`,
 * looked up by the caller) → parsed from the version.
 */
export function sourceBranchOf(
  release: GHRelease,
  prHeads: ReadonlyMap<number, string>,
  remoteBranches: string[],
  defaultBranch: string,
): string {
  const fromMetadata = branchFromMetadata(release);
  if (fromMetadata) return fromMetadata;
  const pr = prNumberFromBody(release.body);
  const fromPr = pr === undefined ? undefined : prHeads.get(pr);
  if (fromPr) return fromPr;
  const version = versionFromTag(release.tag_name);
  if (!semver.valid(version)) return defaultBranch;
  return branchFromKey(
    branchKeyFromVersion(version),
    semver.major(version),
    remoteBranches,
    defaultBranch,
  );
}

/** PR numbers that must be looked up: releases whose metadata carries no `branch`. */
export function prNumbersToLookUp(releases: GHRelease[]): number[] {
  const numbers = new Set<number>();
  for (const r of releases) {
    if (branchFromMetadata(r)) continue;
    const pr = prNumberFromBody(r.body);
    if (pr !== undefined) numbers.add(pr);
  }
  return [...numbers];
}

export interface BranchGroup {
  /** Source branch name (e.g. `main`, `erd/wire-cut/batched-ids`). */
  branch: string;
  /** False when neither the branch nor its `release/` counterpart is on origin any more. */
  exists: boolean;
  releases: GHRelease[];
}

/**
 * Group releases by source branch. Order: `current`, then `defaultBranch`, then
 * by most recent release.
 */
export function groupBySourceBranch(
  releases: GHRelease[],
  branchOf: (release: GHRelease) => string,
  remoteBranches: string[],
  current: string,
  defaultBranch: string,
): BranchGroup[] {
  const groups = new Map<string, BranchGroup>();
  for (const r of releases) {
    const branch = branchOf(r);
    let group = groups.get(branch);
    if (!group) {
      const exists =
        remoteBranches.includes(branch) || remoteBranches.includes(RELEASE_PREFIX + branch);
      groups.set(branch, (group = { branch, exists, releases: [] }));
    }
    group.releases.push(r);
  }
  const rank = (g: BranchGroup): number =>
    g.branch === stripReleasePrefix(current) ? 0 : g.branch === defaultBranch ? 1 : 2;
  const newest = (g: BranchGroup): string =>
    g.releases.reduce((max, r) => (r.created_at > max ? r.created_at : max), '');
  return [...groups.values()].sort(
    (a, b) => rank(a) - rank(b) || newest(b).localeCompare(newest(a)),
  );
}

/**
 * One representative release per distinct version, newest-first — the shape
 * `buildVersionChoices` / `resolveVersionKeyword` expect, across all packages.
 */
export function distinctVersions(releases: GHRelease[]): GHRelease[] {
  const byVersion = new Map<string, GHRelease>();
  for (const r of releases) {
    const version = versionFromTag(r.tag_name);
    if (!packageFromTag(r.tag_name) || !semver.valid(version)) continue;
    if (!byVersion.has(version)) byVersion.set(version, r);
  }
  return [...byVersion.values()].sort((a, b) =>
    semver.rcompare(versionFromTag(a.tag_name), versionFromTag(b.tag_name)),
  );
}

/** The release of each package that has exactly `version`. */
export function packagesAtVersion(
  releases: GHRelease[],
  version: string,
): Record<string, GHRelease> {
  const result: Record<string, GHRelease> = {};
  for (const r of releases) {
    const pkg = packageFromTag(r.tag_name);
    const v = versionFromTag(r.tag_name);
    if (!pkg || !semver.valid(v) || !semver.eq(v, version)) continue;
    result[pkg] ??= r;
  }
  return result;
}

/**
 * Refs to try for the workflow dispatch, best first: the source branch, then the
 * current branch, then the default branch — each as `release/<b>` before `<b>`.
 */
export function dispatchRefCandidates(
  source: string,
  current: string,
  defaultBranch: string,
): string[] {
  const candidates: string[] = [];
  for (const b of [source, current, defaultBranch]) {
    if (!b) continue;
    const bare = stripReleasePrefix(b);
    candidates.push(RELEASE_PREFIX + bare, bare);
  }
  return [...new Set(candidates)];
}

// ─── release grouping ─────────────────────────────────────────────────────────

/**
 * Group releases by package name (extracted from tag).
 * Each group is sorted newest-first by semver.
 * Tags that aren't `{name}/v{semver}` are excluded.
 */
export function groupByPackage(releases: GHRelease[]): Record<string, GHRelease[]> {
  const groups: Record<string, GHRelease[]> = {};
  for (const r of releases) {
    const pkg = packageFromTag(r.tag_name);
    if (!pkg || !semver.valid(versionFromTag(r.tag_name))) continue;
    (groups[pkg] ??= []).push(r);
  }
  for (const pkg of Object.keys(groups)) {
    groups[pkg].sort((a, b) =>
      semver.rcompare(versionFromTag(a.tag_name), versionFromTag(b.tag_name)),
    );
  }
  return groups;
}

// ─── version resolution ───────────────────────────────────────────────────────

/**
 * Resolve a version keyword or explicit version string to a release.
 * - `"latest"` → highest non-pre-release version
 * - `"next"`   → highest version including pre-releases
 * - anything else → semver-equal match against tag
 *
 * Assumes releases are already sorted newest-first.
 */
export function resolveVersionKeyword(
  keyword: string,
  releases: GHRelease[],
): GHRelease | undefined {
  if (keyword === 'latest') return releases.find((r) => !isPrerelease(r));
  if (keyword === 'next') return releases[0];
  if (!semver.valid(keyword)) return undefined;
  return releases.find((r) => semver.eq(versionFromTag(r.tag_name), keyword));
}

/** Sentinel value returned when the user selects "Show more versions...". */
export const LOAD_MORE = '__load_more__' as const;

// ─── prompt choices ───────────────────────────────────────────────────────────

/**
 * Build a version choice list for a package's releases.
 * Always puts `next` and `latest` at the top (with version labels),
 * followed by recent releases. When `showAll` is false (default) and there
 * are more than the visible window, a "Show N more..." sentinel is appended.
 *
 * Assumes releases are already sorted newest-first by version.
 */
export function buildVersionChoices(releases: GHRelease[], showAll = false): prompts.Choice[] {
  const VISIBLE = 5; // additional entries below next/latest
  const choices: prompts.Choice[] = [];
  const seen = new Set<number>();

  const next = releases[0];
  const latest = releases.find((r) => !isPrerelease(r));

  if (next) {
    const label = `next   — ${versionFromTag(next.tag_name)}${isPrerelease(next) ? ' (pre-release)' : ''}`;
    choices.push({ title: label, value: next });
    seen.add(next.id);
  }
  if (latest && !seen.has(latest.id)) {
    choices.push({ title: `latest — ${versionFromTag(latest.tag_name)}`, value: latest });
    seen.add(latest.id);
  }

  let shown = 0;
  for (const r of releases) {
    if (seen.has(r.id)) continue;
    if (!showAll && shown >= VISIBLE) break;
    const ver = versionFromTag(r.tag_name);
    choices.push({ title: `${ver}${isPrerelease(r) ? ' (pre-release)' : ''}`, value: r });
    seen.add(r.id);
    shown++;
  }

  const remaining = releases.filter((r) => !seen.has(r.id)).length;
  if (!showAll && remaining > 0) {
    choices.push({
      title: `⇧  Show ${remaining} more version${remaining === 1 ? '' : 's'}...`,
      value: LOAD_MORE,
    });
  }

  return choices;
}

// ─── artifact metadata ────────────────────────────────────────────────────────

/**
 * Extract and parse the `## Artifact Metadata` YAML block from a release body.
 * Returns the parsed descriptor, or `undefined` if the block is absent/invalid.
 */
export function extractArtifactMetadata(
  body: string | null | undefined,
): MetadataDescriptor | undefined {
  if (!body) return undefined;
  const match = body.match(/## Artifact Metadata\n```yaml\n([\s\S]*?)\n```/);
  if (!match) return undefined;
  try {
    const parsed = parseYaml(match[1]);
    if (parsed && typeof parsed === 'object') return parsed as MetadataDescriptor;
  } catch {
    // Malformed YAML — treat as no metadata.
  }
  return undefined;
}

/**
 * Deploy methods advertised by a release, derived from its Artifact Metadata.
 * Returns only methods that are:
 *   1. Marked published:true on their artifact entry (all assets uploaded)
 *   2. Have their deploy-<m>.zip asset present (belt-and-suspenders)
 *
 * A release mid-publish has metadata but not published:true, so it won't
 * appear in the deploy list until the publish workflow completes.
 */
export function releaseDeployMethods(release: GHRelease): string[] {
  const descriptor = extractArtifactMetadata(release.body);
  if (!descriptor?.artifacts) return [];
  const methods: string[] = [];
  for (const artifact of descriptor.artifacts as (MetadataArtifact & { published?: boolean })[]) {
    // Require explicit published:true — mid-publish releases have published:false
    if (artifact.published !== true) continue;
    if (!Array.isArray(artifact.deploy)) continue;
    for (const method of artifact.deploy) {
      if (typeof method === 'string' && method && !methods.includes(method)) {
        methods.push(method);
      }
    }
  }
  // Belt-and-suspenders: also verify the asset zip is present
  const assetNames = new Set(release.assets.map((a) => a.name));
  return methods.filter((m) => assetNames.has(`deploy-${m}.zip`));
}

/** A release is deployable when its Artifact Metadata advertises ≥1 deploy method. */
export function isDeployable(release: GHRelease): boolean {
  return releaseDeployMethods(release).length > 0;
}

/** The default deploy method to pre-select: the first advertised in declaration order. */
export function defaultMethod(methods: string[]): string | undefined {
  return methods[0];
}

// ─── deploy workflow parsing ──────────────────────────────────────────────────

/**
 * Parse the GitHub Environment name from a `deploy-*.yml` workflow.
 * Reads `jobs.deploy.environment`, which may be a plain string or an object
 * with a `name` field. Returns `undefined` when it cannot be resolved.
 */
export function parseWorkflowEnvironment(ymlText: string): string | undefined {
  let doc: unknown;
  try {
    doc = parseYaml(ymlText);
  } catch {
    return undefined;
  }
  const deployJob = (doc as { jobs?: { deploy?: { environment?: unknown } } })?.jobs?.deploy;
  const environment = deployJob?.environment;
  if (typeof environment === 'string') return environment.trim() || undefined;
  if (environment && typeof environment === 'object') {
    const name = (environment as { name?: unknown }).name;
    if (typeof name === 'string') return name.trim() || undefined;
  }
  return undefined;
}
