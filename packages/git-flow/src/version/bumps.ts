import * as semver from 'semver';
import { $ } from 'zx';
import { extractVersionParts, buildVersion } from './utils.js';

const CHANNEL_ORDER = ['dev', 'alpha', 'beta', 'rc'] as const;
type Channel = (typeof CHANNEL_ORDER)[number];

export interface BumpOption {
  id: string;
  label: string;
  result: string;
  description: string;
  group: 'finish-prerelease' | 'stay-prerelease' | 'next-version' | 'next-version-stable';
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * Returns the display name for a version placeholder.
 * e.g. "0.0.0-MAIN" → "MAIN"
 */
export function keyDisplayName(placeholder: string): string {
  return placeholder.replace(/^0\.0\.0-/, '');
}

function getChannel(prerelease: string[]): Channel | null {
  for (const p of prerelease) {
    const lower = p.toLowerCase();
    if (CHANNEL_ORDER.includes(lower as Channel)) return lower as Channel;
  }
  return null;
}

function advancePrerelease(prerelease: string[]): string[] {
  const result = [...prerelease];
  for (let i = result.length - 1; i >= 0; i--) {
    if (/^\d+$/.test(result[i])) {
      result[i] = String(Number(result[i]) + 1);
      return result;
    }
  }
  return [...result, '1'];
}

function changeChannel(prerelease: string[], newChannel: Channel): string[] {
  const idx = prerelease.findIndex((p) =>
    CHANNEL_ORDER.includes(p.toLowerCase() as Channel),
  );
  if (idx === -1) return [newChannel, '0'];
  const result = prerelease.slice(0, idx + 1);
  result[idx] = newChannel;
  // Reset the immediately following numeric counter to 0
  if (idx + 1 < prerelease.length && /^\d+$/.test(prerelease[idx + 1])) {
    result.push('0');
  } else {
    result.push('0');
  }
  return result;
}

/**
 * Build the patch/minor/major bump options for a base version. Each bump yields
 * both a pre-release (`-dev.0`) option and a direct stable option, so the caller
 * can offer "start a pre-release" and "ship a stable release" side by side.
 */
function nextVersionOptions(base: string): BumpOption[] {
  const opts: BumpOption[] = [];
  for (const bump of ['patch', 'minor', 'major'] as const) {
    const bumped = semver.inc(base, bump)!;
    opts.push({
      id: bump,
      label: bump,
      result: buildVersion(bumped, ['dev', '0']),
      description: 'pre-release',
      group: 'next-version',
    });
    opts.push({
      id: `${bump}-stable`,
      label: bump,
      result: bumped,
      description: 'stable',
      group: 'next-version-stable',
    });
  }
  return opts;
}

/**
 * Compute all candidate version bumps for a given base version.
 * Pure semver — no I/O. Callers should pass through filterExistingTags to
 * mark options that would collide with already-published git tags.
 */
export function computeBumpOptions(currentVersion: string): BumpOption[] {
  const parsed = semver.parse(currentVersion);
  if (!parsed) throw new Error(`Invalid semver: ${currentVersion}`);

  const { base, prerelease } = extractVersionParts(currentVersion);
  const options: BumpOption[] = [];

  if (prerelease.length > 0) {
    const channel = getChannel(prerelease);

    // ── finish-prerelease ─────────────────────────────────────────────────
    options.push({
      id: 'release',
      label: 'release',
      result: base,
      description: 'drop pre-release, ship it',
      group: 'finish-prerelease',
    });

    // ── stay-prerelease: next ──────────────────────────────────────────────
    options.push({
      id: 'next',
      label: 'next',
      result: buildVersion(base, advancePrerelease(prerelease)),
      description: channel ? `next in ${channel} channel` : 'increment pre-release',
      group: 'stay-prerelease',
    });

    // ── stay-prerelease: channel upgrades ─────────────────────────────────
    if (channel) {
      const idx = CHANNEL_ORDER.indexOf(channel);
      for (let i = idx + 1; i < CHANNEL_ORDER.length; i++) {
        const next = CHANNEL_ORDER[i];
        options.push({
          id: `channel-${next}`,
          label: `→ ${next}`,
          result: buildVersion(base, changeChannel(prerelease, next)),
          description: `${channel} → ${next}`,
          group: 'stay-prerelease',
        });
      }
    }

    // ── next-version ──────────────────────────────────────────────────────
    options.push(...nextVersionOptions(base));
  } else {
    // ── stable: next-version (pre-release + stable variants) ──────────────
    options.push(...nextVersionOptions(base));
  }

  return options;
}

/**
 * Check whether a plain version tag (v{version}) exists locally or on origin.
 * Intentionally silent — suitable for interactive CLI use.
 */
async function tagExists(version: string): Promise<boolean> {
  $.verbose = false;
  const tag = `v${version}`;
  try {
    const local = await $`git tag -l ${tag}`.nothrow();
    if (local.stdout.trim() === tag) return true;
    const remote = await $`git ls-remote --tags origin refs/tags/${tag}`.nothrow();
    if (remote.stdout.trim().length > 0) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Mark bump options whose resulting version would collide with an existing tag.
 * For pre-release results, also checks whether the stable base version is already
 * tagged (a shipped stable release closes that version to further pre-releases).
 */
export async function filterExistingTags(options: BumpOption[]): Promise<BumpOption[]> {
  return Promise.all(
    options.map(async (opt) => {
      if (await tagExists(opt.result)) {
        return { ...opt, disabled: true, disabledReason: 'tag already released' };
      }
      // Pre-release result: also block if the stable version is already tagged
      const parsed = semver.parse(opt.result);
      if (parsed && parsed.prerelease.length > 0) {
        const stable = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
        if (await tagExists(stable)) {
          return { ...opt, disabled: true, disabledReason: 'tag already released' };
        }
      }
      return opt;
    }),
  );
}
