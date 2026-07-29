/**
 * Pure utility functions for the `gitflow deploy` command.
 * Extracted here so they can be imported and unit-tested independently.
 */

import type prompts from 'prompts';
import { parse as parseYaml } from 'yaml';

// ─── types ────────────────────────────────────────────────────────────────────

export interface GHRelease {
  id: number;
  tag_name: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
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
  artifacts?: MetadataArtifact[];
}

// ─── tag helpers ──────────────────────────────────────────────────────────────

/** Extract the semver string from a gitflow tag (e.g. `v1.2.3/@org/pkg` → `1.2.3`). */
export function versionFromTag(tag: string): string {
  return tag.match(/^v([^/]+)\//)?.[1] ?? tag;
}

/** Extract the package name from a gitflow tag (e.g. `v1.2.3/@org/pkg` → `@org/pkg`). */
export function packageFromTag(tag: string): string | undefined {
  return tag.match(/^v[^/]+\/(.+)$/)?.[1];
}

/** Parse a GitHub repo slug from a git remote URL (https or ssh). */
export function parseRepoFromUrl(remoteUrl: string): string {
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot determine GitHub repo from remote URL: ${remoteUrl}`);
  return match[1];
}

// ─── version comparison ───────────────────────────────────────────────────────

/**
 * Semver-aware comparison.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 * Pre-release versions sort below their stable equivalent.
 */
export function compareVersions(a: string, b: string): number {
  const splitSemver = (v: string): [number[], string] => {
    const [core, pre = ''] = v.split('-');
    const nums = (core || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
    return [nums, pre];
  };

  const [numsA, preA] = splitSemver(a);
  const [numsB, preB] = splitSemver(b);

  for (let i = 0; i < 3; i++) {
    const diff = (numsA[i] ?? 0) - (numsB[i] ?? 0);
    if (diff !== 0) return diff;
  }

  // Same core: stable > pre-release
  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  return preA.localeCompare(preB);
}

// ─── release grouping ─────────────────────────────────────────────────────────

/**
 * Group releases by package name (extracted from tag).
 * Each group is sorted newest-first by version.
 * Releases with non-gitflow tags are excluded.
 */
export function groupByPackage(releases: GHRelease[]): Record<string, GHRelease[]> {
  const groups: Record<string, GHRelease[]> = {};
  for (const r of releases) {
    const pkg = packageFromTag(r.tag_name);
    if (!pkg) continue;
    (groups[pkg] ??= []).push(r);
  }
  for (const pkg of Object.keys(groups)) {
    groups[pkg].sort((a, b) =>
      compareVersions(versionFromTag(b.tag_name), versionFromTag(a.tag_name)),
    );
  }
  return groups;
}

// ─── version resolution ───────────────────────────────────────────────────────

/**
 * Resolve a version keyword or explicit version string to a release.
 * - `"latest"` → highest non-pre-release version
 * - `"next"`   → highest version including pre-releases
 * - anything else → exact semver match against tag
 *
 * Assumes releases are already sorted newest-first.
 */
export function resolveVersionKeyword(
  keyword: string,
  releases: GHRelease[],
): GHRelease | undefined {
  if (keyword === 'latest') return releases.find((r) => !r.prerelease);
  if (keyword === 'next') return releases[0];
  return releases.find((r) => versionFromTag(r.tag_name) === keyword);
}

// ─── prompt choices ───────────────────────────────────────────────────────────

/**
 * Build a version choice list for a package's releases.
 * Always puts `next` and `latest` at the top (with version labels),
 * followed by up to 5 additional recent releases.
 *
 * Assumes releases are already sorted newest-first.
 */
export function buildVersionChoices(releases: GHRelease[]): prompts.Choice[] {
  const choices: prompts.Choice[] = [];
  const seen = new Set<number>();

  const next = releases[0];
  const latest = releases.find((r) => !r.prerelease);

  if (next) {
    const label = `next   — ${versionFromTag(next.tag_name)}${next.prerelease ? ' (pre-release)' : ''}`;
    choices.push({ title: label, value: next });
    seen.add(next.id);
  }
  if (latest && !seen.has(latest.id)) {
    choices.push({ title: `latest — ${versionFromTag(latest.tag_name)}`, value: latest });
    seen.add(latest.id);
  }

  for (const r of releases) {
    if (seen.has(r.id)) continue;
    if (choices.length >= 7) break;
    const ver = versionFromTag(r.tag_name);
    choices.push({ title: `${ver}${r.prerelease ? ' (pre-release)' : ''}`, value: r });
    seen.add(r.id);
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
 * Returns the de-duplicated union of every artifact's `deploy` array, preserving
 * declaration order. Each method `m` corresponds to a `deploy-<m>.zip` asset.
 */
export function releaseDeployMethods(release: GHRelease): string[] {
  const descriptor = extractArtifactMetadata(release.body);
  if (!descriptor?.artifacts) return [];
  const methods: string[] = [];
  for (const artifact of descriptor.artifacts) {
    if (!Array.isArray(artifact.deploy)) continue;
    for (const method of artifact.deploy) {
      if (typeof method === 'string' && method && !methods.includes(method)) {
        methods.push(method);
      }
    }
  }
  return methods;
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
