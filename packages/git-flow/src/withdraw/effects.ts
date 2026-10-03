/**
 * The side of a withdrawal that needs registry credentials: repointing
 * floating tags, marking or deleting registry versions, deleting assets.
 *
 * Runs inside the repository's `withdraw.yml` workflow, dispatched by
 * `gitflow withdraw` after it has written the marker. The marker always comes
 * first and never depends on anything here succeeding.
 */

import * as semver from 'semver';
import { $ } from 'zx';
import { listProjectVersions, parseReleaseTag } from '../build-pack/github.js';
import { parse as parseYaml } from 'yaml';
import {
  channelOf,
  computeFloatingTags,
  isFloatingEligible,
  type Channel,
} from '../publishing/floating-tags.js';
import { deleteGitHubPackageVersion, githubPackageRef } from '../publishing/github-packages.js';
import { dockerLogin, resolveDockerImageBase } from '../publishing/publishers.js';
import {
  getRegistry,
  getToken,
  isGitHubRegistry,
  loadRegistryConfig,
} from '../publishing/registry-config.js';
import type { Registry, RegistryConfig } from '../publishing/types.js';
import { readWithdrawal, setWithdrawalInBody } from './metadata.js';
import {
  getRelease,
  deleteReleaseAssets,
  listWithdrawnVersions,
  type ReleaseSummary,
} from './release.js';
import type { AssetsEffect, RegistryEffect, Withdrawal } from './types.js';
import { getOctokit } from '@actions/github';

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

/** Which version each floating pointer should name, given the eligible set. */
export function floatingTagOwners(eligible: string[]): Record<string, string> {
  const versions = eligible.filter(isFloatingEligible);
  const highest = (c: string[]): string | undefined => semver.rsort(c)[0];
  const owners: Record<string, string> = {};
  const latest = highest(versions.filter((v) => !channelOf(v)));
  if (latest) owners['latest'] = latest;
  const next = highest(versions);
  if (next) owners['next'] = next;
  const channels = [...new Set(versions.map(channelOf))].filter(
    (c): c is Channel => c !== undefined,
  );
  for (const channel of channels) {
    owners[channel] = highest(versions.filter((v) => channelOf(v) === channel))!;
  }
  return owners;
}

export interface Repoint {
  tag: string;
  /** New owner, or undefined when nothing eligible remains and the tag should go. */
  to: string | undefined;
}

/**
 * Pointers to move when `version` is withdrawn: the ones it currently holds,
 * each sent to the next eligible version. `others` are the project's other
 * versions with withdrawn ones already removed.
 */
export function planWithdrawRepoints(version: string, others: string[]): Repoint[] {
  const held = computeFloatingTags(version, others);
  const owners = floatingTagOwners(others.filter((v) => v !== version));
  return held.map((tag) => ({ tag, to: owners[tag] }));
}

/** Pointers `version` takes back when it is restored, given the eligible `others`. */
export function planRestoreRepoints(version: string, others: string[]): Repoint[] {
  return computeFloatingTags(version, others).map((tag) => ({ tag, to: version }));
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface WithdrawEffectsOptions {
  githubToken: string;
  owner: string;
  repo: string;
  /** Checkout of the repository, for `.publish/registries.yml`. */
  workspaceRoot: string;
  releaseIds: number[];
  registry: RegistryEffect;
  assets: AssetsEffect;
  /** Restore instead of withdraw: repoint tags back and undo reversible marks. */
  undo: boolean;
  log?: (line: string) => void;
}

export interface ReleaseEffectsResult {
  releaseId: number;
  project: string;
  version: string;
  repoints: Array<Repoint & { applied: string[] }>;
  registry: NonNullable<Withdrawal['registry']>;
  assets: NonNullable<Withdrawal['assets']>;
  notes: string[];
}

interface MetadataArtifact {
  type?: string;
  name?: string;
  registries?: string[];
}

function artifactsOf(body: string | null): MetadataArtifact[] {
  const m = body?.match(/## Artifact Metadata\s*```yaml\s*\n([\s\S]*?)\n\s*```/m);
  if (!m) return [];
  try {
    const parsed = parseYaml(m[1]!) as { artifacts?: MetadataArtifact[] };
    return parsed?.artifacts ?? [];
  } catch {
    return [];
  }
}

function npmTargets(artifact: MetadataArtifact, config: RegistryConfig): Registry[] {
  return (artifact.registries ?? [])
    .map((id) => getRegistry(config, id))
    .filter((r) => r.type === 'npm');
}

async function npmAuth(registry: Extract<Registry, { type: 'npm' }>): Promise<void> {
  const url = new URL(registry.url);
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  await $({
    quiet: true,
  })`npm config set ${`//${url.host}${path}:_authToken`} ${getToken(registry)}`;
}

export async function applyWithdrawEffects(
  options: WithdrawEffectsOptions,
): Promise<ReleaseEffectsResult[]> {
  const log = options.log ?? ((l: string) => console.log(l));
  const { githubToken: token, owner, repo } = options;
  const config = await loadRegistryConfig(options.workspaceRoot);
  const results: ReleaseEffectsResult[] = [];

  for (const releaseId of options.releaseIds) {
    const release = await getRelease(token, owner, repo, releaseId);
    const parsed = parseReleaseTag(release.tag_name);
    if (!parsed) {
      log(`⏭️  release ${releaseId} (${release.tag_name}) is not a git-flow release; skipped`);
      continue;
    }
    const { name: project, version } = parsed;
    const result: ReleaseEffectsResult = {
      releaseId,
      project,
      version,
      repoints: [],
      registry: 'none',
      assets: 'kept',
      notes: [],
    };
    log(`\n▸ ${project}@${version} (${options.undo ? 'restore' : 'withdraw'})`);

    // 1. Floating tags. Judged against every version the project has tagged,
    //    minus the withdrawn ones — the marker for this release is already
    //    written (or cleared), so the current state is what we want.
    const all = await listProjectVersions(token, owner, repo, project);
    const withdrawn = new Set(await listWithdrawnVersions(token, owner, repo, project));
    const others = all.filter((v) => v !== version && !withdrawn.has(v));
    const plan = options.undo
      ? planRestoreRepoints(version, others)
      : planWithdrawRepoints(version, others);
    const artifacts = artifactsOf(release.body);
    for (const repoint of plan) {
      const applied = await applyRepoint(repoint, project, artifacts, config, log, result.notes);
      result.repoints.push({ ...repoint, applied });
    }
    if (plan.length === 0) log('  🏷️  floating tags: none held by this version');

    // 2. Registry effect.
    if (options.undo) {
      result.registry = await undoRegistryMarks(artifacts, version, config, log, result.notes);
    } else if (options.registry !== 'none') {
      result.registry = await applyRegistryEffect(
        options.registry,
        artifacts,
        version,
        owner,
        token,
        config,
        log,
        result.notes,
      );
    }

    // 3. Assets.
    if (!options.undo && options.assets === 'delete') {
      const removed = await deleteReleaseAssets(token, owner, repo, release);
      log(`  🗑️  assets deleted: ${removed.join(', ') || '(none)'}`);
      result.assets = 'deleted';
    }

    // 4. Record outcomes in the marker (withdraw only; restore already cleared it).
    if (!options.undo) await recordOutcome(token, owner, repo, release, result);
    results.push(result);
  }
  return results;
}

async function applyRepoint(
  repoint: Repoint,
  project: string,
  artifacts: MetadataArtifact[],
  config: RegistryConfig,
  log: (l: string) => void,
  notes: string[],
): Promise<string[]> {
  const applied: string[] = [];
  for (const artifact of artifacts) {
    if (!artifact.type || !artifact.name) continue;
    if (artifact.type === 'npm' || artifact.type === 'ng-lib') {
      for (const registry of npmTargets(artifact, config)) {
        if (registry.type !== 'npm') continue;
        await npmAuth(registry);
        if (repoint.to) {
          await $`npm dist-tag add ${`${artifact.name}@${repoint.to}`} ${repoint.tag} --registry ${registry.url}`;
          log(`  🏷️  npm ${artifact.name}: ${repoint.tag} → ${repoint.to} (${registry.url})`);
        } else {
          await $`npm dist-tag rm ${artifact.name} ${repoint.tag} --registry ${registry.url}`.nothrow();
          log(`  🏷️  npm ${artifact.name}: ${repoint.tag} removed (nothing eligible remains)`);
        }
        applied.push(`npm:${registry.url}`);
      }
    } else if (artifact.type === 'docker-image' || artifact.type === 'docker') {
      for (const id of artifact.registries ?? []) {
        const registry = getRegistry(config, id);
        if (registry.type !== 'docker') continue;
        const base = resolveDockerImageBase(artifact.name, registry);
        if (repoint.to) {
          await dockerLogin(registry, getToken(registry));
          // Server-side retag by manifest: nothing is pulled.
          await $`docker buildx imagetools create -t ${`${base}:${repoint.tag}`} ${`${base}:${repoint.to}`}`;
          log(`  🏷️  docker ${base}: ${repoint.tag} → ${repoint.to}`);
          applied.push(`docker:${registry.registry}`);
        } else {
          const note = `docker ${base}:${repoint.tag} still points at ${project} — a tag cannot be removed without deleting the version; use --registry delete`;
          log(`  ⚠️  ${note}`);
          notes.push(note);
        }
      }
    }
  }
  return applied;
}

async function applyRegistryEffect(
  effect: Exclude<RegistryEffect, 'none'>,
  artifacts: MetadataArtifact[],
  version: string,
  owner: string,
  token: string,
  config: RegistryConfig,
  log: (l: string) => void,
  notes: string[],
): Promise<NonNullable<Withdrawal['registry']>> {
  let outcome: NonNullable<Withdrawal['registry']> = 'none';
  const upgrade = (o: NonNullable<Withdrawal['registry']>): void => {
    const rank = { none: 0, pending: 0, unsupported: 1, marked: 2, deleted: 3 };
    if (rank[o] > rank[outcome]) outcome = o;
  };
  for (const artifact of artifacts) {
    if (!artifact.type || !artifact.name) continue;
    for (const id of artifact.registries ?? []) {
      const registry = getRegistry(config, id);
      const label = `${artifact.type} ${artifact.name}@${version} → ${id}`;
      let done = false;
      if (effect === 'delete') {
        if (isGitHubRegistry(registry)) {
          const ref = githubPackageRef(artifact.type, artifact.name);
          if (ref) {
            const r = await deleteGitHubPackageVersion(token, owner, ref, version);
            if (r === 'deleted') {
              log(`  🗑️  ${label}: deleted from GitHub Packages`);
              upgrade('deleted');
              done = true;
            } else {
              const note = `${label}: delete returned ${r}; falling back to mark`;
              log(`  ⚠️  ${note}`);
              notes.push(note);
            }
          }
        } else if (registry.type === 'npm') {
          await npmAuth(registry);
          const r =
            await $`npm unpublish ${`${artifact.name}@${version}`} --registry ${registry.url}`.nothrow();
          if (r.exitCode === 0) {
            log(`  🗑️  ${label}: unpublished`);
            upgrade('deleted');
            done = true;
          } else {
            notes.push(
              `${label}: unpublish refused (${r.stderr.trim().split('\n')[0]}); falling back to mark`,
            );
          }
        }
      }
      if (!done) {
        // mark, or the fallback from a failed delete
        if (registry.type === 'npm') {
          await npmAuth(registry);
          const message = `WITHDRAWN: see release ${artifact.name}/v${version}`;
          const r =
            await $`npm deprecate ${`${artifact.name}@${version}`} ${message} --registry ${registry.url}`.nothrow();
          if (r.exitCode === 0) {
            log(`  ⛔ ${label}: deprecated`);
            upgrade('marked');
          } else {
            // GitHub Packages' npm registry does not implement deprecate (it
            // rejects the packument PUT with E400); npmjs does. Either way the
            // release marker remains the record.
            const first =
              r.stderr
                .trim()
                .split('\n')
                .find((l) => l.includes('npm error')) ?? '';
            const why =
              first.includes('E400') || registry.url.includes('npm.pkg.github.com')
                ? 'this registry does not support npm deprecate'
                : first.replace(/^npm error\s*/, '') || 'npm deprecate failed';
            const note = `${label}: ${why}; the release marker is the record`;
            log(`  ℹ️  ${note}`);
            notes.push(note);
            upgrade('unsupported');
          }
        } else {
          const note = `${label}: ${registry.type} registries cannot mark a version; the release marker is the record`;
          log(`  ℹ️  ${note}`);
          notes.push(note);
          upgrade('unsupported');
        }
      }
    }
  }
  return outcome;
}

async function undoRegistryMarks(
  artifacts: MetadataArtifact[],
  version: string,
  config: RegistryConfig,
  log: (l: string) => void,
  notes: string[],
): Promise<NonNullable<Withdrawal['registry']>> {
  let any = false;
  for (const artifact of artifacts) {
    if (!artifact.type || !artifact.name) continue;
    for (const id of artifact.registries ?? []) {
      const registry = getRegistry(config, id);
      if (registry.type === 'npm') {
        await npmAuth(registry);
        const r =
          await $`npm deprecate ${`${artifact.name}@${version}`} ${''} --registry ${registry.url}`.nothrow();
        if (r.exitCode === 0) {
          log(`  ♻️  npm ${artifact.name}@${version}: deprecation cleared (${id})`);
          any = true;
        } else {
          notes.push(
            `npm ${artifact.name}@${version} → ${id}: could not clear deprecation (version may have been deleted)`,
          );
        }
      }
    }
  }
  if (!any) log('  ℹ️  registries: nothing reversible to undo (deletions are permanent)');
  return 'none';
}

async function recordOutcome(
  token: string,
  owner: string,
  repo: string,
  release: ReleaseSummary,
  result: ReleaseEffectsResult,
): Promise<void> {
  const current = await getRelease(token, owner, repo, release.id);
  const withdrawal = readWithdrawal(current.body);
  if (!withdrawal) return; // restored meanwhile; nothing to record
  const body = setWithdrawalInBody(current.body ?? '', {
    ...withdrawal,
    registry: result.registry,
    assets: result.assets,
  });
  await getOctokit(token).rest.repos.updateRelease({ owner, repo, release_id: release.id, body });
}
