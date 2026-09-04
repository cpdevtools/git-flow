/**
 * Floating pointers published alongside a release version.
 *
 * Docker carries them as image tags, npm as dist-tags. Each pointer names the
 * highest version of a class, so it only moves when the version being published
 * *is* that maximum — a maintenance patch cut after a newer line has shipped
 * leaves `latest` alone.
 *
 * | pointer   | meaning                                             |
 * | --------- | --------------------------------------------------- |
 * | `latest`  | highest stable version                              |
 * | `next`    | highest version, prereleases included (≥ `latest`)  |
 * | `alpha` … | highest version of that channel                     |
 *
 * NuGet has no pointer concept and needs none: its clients resolve the same
 * three from version ordering (`latest` by default, `next` via `--prerelease` /
 * `*-*`, a channel via `*-alpha*`).
 */

import * as semver from 'semver';
import type { Artifact } from '@cpdevtools/ts-dev-utilities/artifacts';
import type { PublishContext } from '../artifacts/types.js';

/** Prerelease channels, mirroring CHANNEL_ORDER in ../version/bumps.ts */
export const CHANNELS = ['alpha', 'beta', 'rc'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Only mainline releases carry pointers: `X.Y.Z`, or `X.Y.Z-<channel>.N`.
 *
 * The shape test is the whole mainline test. A development branch puts its
 * sanitised name into the prerelease (`2.0.0-feature.auth`,
 * `2.0.0-feature.auth.beta.0`) and a version-collision escape hatch appends
 * `.build.<run>` — neither parses as `[channel, number]`, so neither is eligible.
 */
export function isFloatingEligible(version: string): boolean {
  const parsed = semver.parse(version);
  if (!parsed || parsed.build.length > 0) return false;
  if (parsed.prerelease.length === 0) return true;
  return parsed.prerelease.length === 2 && channelOf(version) !== undefined;
}

/** The channel of an eligible prerelease; undefined for stable or ineligible versions. */
export function channelOf(version: string): Channel | undefined {
  const parsed = semver.parse(version);
  if (!parsed || parsed.prerelease.length !== 2) return undefined;
  const [id, n] = parsed.prerelease;
  return typeof n === 'number' && CHANNELS.includes(id as Channel) ? (id as Channel) : undefined;
}

/**
 * The pointers `version` earns, given every version of the project that exists.
 *
 * `existing` may contain anything — ineligible entries are ignored, and `version`
 * itself is included whether or not it is listed (at publish time its own tag
 * has not been created yet). Result order is by importance: `latest`, `next`,
 * then the channel — callers that can only apply one pointer take the first.
 */
export function computeFloatingTags(version: string, existing: string[]): string[] {
  if (!isFloatingEligible(version)) return [];

  const eligible = new Set([version, ...existing.filter(isFloatingEligible)]);
  const all = [...eligible];
  const highest = (candidates: string[]): string | undefined => semver.rsort(candidates)[0];

  const tags: string[] = [];
  const channel = channelOf(version);

  if (!channel && highest(all.filter((v) => !channelOf(v))) === version) tags.push('latest');
  if (highest(all) === version) tags.push('next');
  if (channel && highest(all.filter((v) => channelOf(v) === channel)) === version) {
    tags.push(channel);
  }

  return tags;
}

/**
 * Pointers to publish for one artifact: the project's computed set, unless the
 * artifact opts out with `floatingTags: false` in release-artifacts.yml.
 */
export function floatingTagsFor(artifact: Artifact, ctx: PublishContext): string[] {
  return (artifact as { floatingTags?: unknown }).floatingTags === false ? [] : ctx.floatingTags;
}
