/**
 * gitflow deploy
 *
 * Interactive CLI that scans the repo's deployable releases into one master list
 * and narrows it with each selection — environment → source branch → version →
 * packages — then dispatches the per-environment deploy workflow via the GitHub
 * API. The version determines which packages can be deployed, and the workflow
 * runs on the ref mapped from the release's source branch.
 *
 * Required env vars:
 *   GITHUB_TOKEN — PAT with actions:write + contents:read
 *
 * Every prompt is short-circuitable via flags:
 *   --target  -t  Target environment (e.g. production, dev)
 *   --branch  -b  Source branch the releases were cut from
 *   --version -v  Version to deploy: semver, "latest", or "next"
 *   --package -p  Package name(s) to deploy (repeatable)
 *   --method  -m  Deploy method (e.g. node, compose, swarm)
 *   --ref         Force the ref the workflow is dispatched on
 *   --yes     -y  Skip confirmation prompt
 *   --repo    -r  Override GitHub repo (owner/repo)
 */

import { Command, Flags } from '@oclif/core';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import prompts from 'prompts';
import {
  type GHRelease,
  versionFromTag,
  parseRepoFromUrl,
  resolveVersionKeyword,
  buildVersionChoices,
  LOAD_MORE,
  isDeployable,
  isGitflowTag,
  releaseDeployMethods,
  defaultMethod,
  parseWorkflowEnvironment,
  filterReleasesByMethods,
  stripReleasePrefix,
  prNumbersToLookUp,
  sourceBranchOf,
  groupBySourceBranch,
  distinctVersions,
  packagesAtVersion,
  dispatchRefCandidates,
} from './deploy-helpers.js';

interface DeployTarget {
  /** GitHub Environment name (from the workflow's `jobs.deploy.environment`). */
  environment: string;
  /** Filename slug fallback (e.g. `deploy-test` from `deploy-deploy-test.yml`). */
  slug: string;
  workflowFile: string;
}

// ─── GitHub API helper ────────────────────────────────────────────────────────

async function gh<T = unknown>(
  token: string,
  path: string,
  options?: RequestInit,
): Promise<T | null> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...((options?.headers ?? {}) as Record<string, string>),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text().catch(() => '')}`);
  }
  if (res.status === 204) return null;
  return res.json() as Promise<T>;
}

// ─── git helpers ──────────────────────────────────────────────────────────────

function getCurrentBranch(): string {
  return execSync('git branch --show-current', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function getRepoFromRemote(): string {
  const url = execSync('git remote get-url origin', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return parseRepoFromUrl(url);
}

// ─── version helpers ──────────────────────────────────────────────────────────
// (All pure helpers live in deploy-helpers.ts and are imported above.)

// ─── release grouping + choices ──────────────────────────────────────────────
// (groupByPackage, resolveVersionKeyword, buildVersionChoices imported above.)

// ─── GitHub queries ───────────────────────────────────────────────────────────

interface EnvironmentConfig {
  /** Allowed deploy methods (from DEPLOY_ALLOWED_METHODS env var). Empty = all allowed. */
  allowedMethods: string[];
  /** Default deploy method (from DEPLOY_TYPE_DEFAULT env var). */
  defaultMethod: string | undefined;
}

/**
 * Read deployment configuration from the GitHub Environment's variables.
 * Best-effort: returns empty config (no restrictions) when the API call fails
 * (e.g. the token lacks permission to read env vars or none are set).
 */
async function fetchEnvironmentConfig(
  token: string,
  owner: string,
  repo: string,
  environment: string,
): Promise<EnvironmentConfig> {
  try {
    const res = await gh<{ variables?: { name: string; value: string }[] }>(
      token,
      `/repos/${owner}/${repo}/environments/${encodeURIComponent(environment)}/variables?per_page=100`,
    );
    const vars = Object.fromEntries((res?.variables ?? []).map(({ name, value }) => [name, value]));
    const allowedMethods = (vars['DEPLOY_ALLOWED_METHODS'] ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const defMethod = vars['DEPLOY_TYPE_DEFAULT']?.trim() || undefined;
    return { allowedMethods, defaultMethod: defMethod };
  } catch {
    // Missing permission or no variables set — apply no restrictions.
    return { allowedMethods: [], defaultMethod: undefined };
  }
}

/** All branch names on origin (paginated). */
async function listRemoteBranches(token: string, owner: string, repo: string): Promise<string[]> {
  const names: string[] = [];
  let page = 1;
  while (true) {
    const batch = await gh<{ name: string }[]>(
      token,
      `/repos/${owner}/${repo}/branches?per_page=100&page=${page}`,
    );
    if (!batch || batch.length === 0) break;
    names.push(...batch.map((b) => b.name));
    if (batch.length < 100) break;
    page++;
  }
  return names;
}

async function fetchDefaultBranch(token: string, owner: string, repo: string): Promise<string> {
  const res = await gh<{ default_branch?: string }>(token, `/repos/${owner}/${repo}`);
  return res?.default_branch ?? 'main';
}

/**
 * Head branch of each PR in `numbers`. Pages the PR list newest-first and stops
 * once every wanted PR is found or the page is past the oldest one wanted.
 * Best-effort: an API failure returns what was found so far, and the caller
 * falls back to parsing the branch out of the version.
 */
async function fetchPrHeads(
  token: string,
  owner: string,
  repo: string,
  numbers: number[],
): Promise<Map<number, string>> {
  const heads = new Map<number, string>();
  if (numbers.length === 0) return heads;
  const wanted = new Set(numbers);
  const oldest = Math.min(...numbers);
  try {
    let page = 1;
    while (heads.size < wanted.size) {
      const batch = await gh<{ number: number; head: { ref: string } }[]>(
        token,
        `/repos/${owner}/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
      );
      if (!batch || batch.length === 0) break;
      for (const pr of batch) {
        if (wanted.has(pr.number)) heads.set(pr.number, pr.head.ref);
      }
      if (batch.length < 100 || batch[batch.length - 1].number <= oldest) break;
      page++;
    }
  } catch {
    // Fall back to version parsing for the PRs not resolved.
  }
  return heads;
}

/** True when `ref` carries the workflow file, i.e. the dispatch can run there. */
async function refHasWorkflow(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  workflowFile: string,
): Promise<boolean> {
  try {
    await gh(
      token,
      `/repos/${owner}/${repo}/contents/.github/workflows/${encodeURIComponent(workflowFile)}?ref=${encodeURIComponent(ref)}`,
    );
    return true;
  } catch {
    return false;
  }
}

async function discoverDeployTargets(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<DeployTarget[]> {
  const contents = await gh<{ name: string }[]>(
    token,
    `/repos/${owner}/${repo}/contents/.github/workflows?ref=${encodeURIComponent(branch)}`,
  );
  const files = (contents ?? []).filter((f) => /^deploy-.+\.yml$/.test(f.name));

  return Promise.all(
    files.map(async (f) => {
      const slug = f.name.replace(/^deploy-(.+)\.yml$/, '$1');
      // Read the workflow body to resolve the real GitHub Environment name
      // (`jobs.deploy.environment`), falling back to the filename slug.
      let environment = slug;
      try {
        const file = await gh<{ content?: string; encoding?: string }>(
          token,
          `/repos/${owner}/${repo}/contents/.github/workflows/${f.name}?ref=${encodeURIComponent(branch)}`,
        );
        if (file?.content) {
          const yml = Buffer.from(
            file.content,
            (file.encoding as BufferEncoding) ?? 'base64',
          ).toString('utf-8');
          environment = parseWorkflowEnvironment(yml) ?? slug;
        }
      } catch {
        // Fall back to the slug if the workflow body can't be read/parsed.
      }
      return { environment, slug, workflowFile: f.name };
    }),
  );
}

async function listDeployableReleases(
  token: string,
  owner: string,
  repo: string,
): Promise<GHRelease[]> {
  const results: GHRelease[] = [];
  let page = 1;
  while (true) {
    const batch = await gh<GHRelease[]>(
      token,
      `/repos/${owner}/${repo}/releases?per_page=100&page=${page}`,
    );
    if (!batch || batch.length === 0) break;
    for (const r of batch) {
      if (r.draft) continue;
      if (isGitflowTag(r.tag_name) && isDeployable(r)) results.push(r);
    }
    if (batch.length < 100) break;
    page++;
  }
  return results;
}

async function dispatchWorkflow(
  token: string,
  owner: string,
  repo: string,
  target: DeployTarget,
  branch: string,
  releaseId: number,
  method?: string,
  deployEnv?: string,
): Promise<string> {
  await gh(
    token,
    `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(target.workflowFile)}/dispatches`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: branch,
        inputs: {
          release_id: String(releaseId),
          ...(method ? { deploy_type: method } : {}),
          ...(deployEnv ? { deploy_env: deployEnv } : {}),
        },
      }),
    },
  );
  return `https://github.com/${owner}/${repo}/actions/workflows/${encodeURIComponent(target.workflowFile)}`;
}

// ─── Command ──────────────────────────────────────────────────────────────────

export default class Deploy extends Command {
  static override description =
    'Interactive deploy — select an environment, source branch, version, and packages, then dispatch the deploy workflow.';

  static override examples = [
    '<%= config.bin %> deploy',
    '<%= config.bin %> deploy --target production --package @org/svc --version latest',
    '<%= config.bin %> deploy --target production --package @org/svc --version next --yes',
    '<%= config.bin %> deploy --target dev --branch feature/checkout --version next --yes',
    '<%= config.bin %> deploy --repo owner/repo --target dev --ref release/main --yes',
  ];

  static override flags = {
    repo: Flags.string({
      char: 'r',
      description: 'GitHub repo (owner/repo). Defaults to the current git remote origin.',
    }),
    branch: Flags.string({
      char: 'b',
      description:
        'Source branch the releases were cut from (e.g. main, feature/checkout). Skips branch prompt.',
    }),
    ref: Flags.string({
      description:
        'Ref to dispatch the workflow on. Defaults to the release branch mapped from the selected version.',
    }),
    target: Flags.string({
      char: 't',
      description: 'Deploy target environment (e.g. production, dev). Skips environment prompt.',
    }),
    package: Flags.string({
      char: 'p',
      description:
        'Package(s) to deploy; must have the selected version. Repeatable. Skips package selection prompt.',
      multiple: true,
    }),
    version: Flags.string({
      char: 'v',
      description:
        'Version to deploy: a semver string, "latest" (highest stable), or "next" (highest including pre-release). Skips version prompt.',
    }),
    method: Flags.string({
      char: 'm',
      description:
        'Deploy method (e.g. node, compose, swarm). Must be advertised by the release. Skips method prompt.',
    }),
    set: Flags.string({
      char: 's',
      description:
        'Per-run deploy env override as KEY=VAL (e.g. --set COMPOSE_FILE=docker-compose.netns.yml). Repeatable.',
      multiple: true,
    }),
    'env-file': Flags.string({
      char: 'e',
      description:
        'File of KEY=VAL lines to merge as deploy env. Repeatable; later files override earlier ones.',
      multiple: true,
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip confirmation prompt.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Deploy);

    const token = process.env['GITHUB_TOKEN'];
    if (!token) this.error('GITHUB_TOKEN environment variable is required.');

    // ── 1. Resolve repo ──────────────────────────────────────────────────────
    const repo = flags.repo ?? getRepoFromRemote();
    const [owner, repoName] = repo.split('/');
    const current = getCurrentBranch();

    // ── 2. Scan deployable releases (the master list) ────────────────────────
    // Every later selection only filters this list down.
    this.log('Fetching releases...');
    const [allReleases, remoteBranches, defaultBranch] = await Promise.all([
      listDeployableReleases(token, owner, repoName),
      listRemoteBranches(token, owner, repoName),
      fetchDefaultBranch(token, owner, repoName),
    ]);
    let releases = allReleases;
    if (releases.length === 0) {
      this.error(
        'No deployable releases found (no published releases advertising a deploy method).',
      );
    }

    // Map releases back to their source branch: metadata `branch` → release PR
    // head → parsed from the version.
    const prHeads = await fetchPrHeads(token, owner, repoName, prNumbersToLookUp(releases));
    const branchOf = (r: GHRelease): string =>
      sourceBranchOf(r, prHeads, remoteBranches, defaultBranch);

    // ── 3. Discover deploy targets ───────────────────────────────────────────
    // Targets are read from the current branch's release branch (else the default
    // one); the ref the workflow runs on is resolved later from the version.
    const scanRef = dispatchRefCandidates('', current, defaultBranch).find((b) =>
      remoteBranches.includes(b),
    );
    if (!scanRef) this.error(`No branch to scan for deploy workflows found in ${repo}.`);
    const targets = await discoverDeployTargets(token, owner, repoName, scanRef!);
    if (targets.length === 0) {
      this.error(`No deploy workflows found on ${scanRef}. Expected files matching deploy-*.yml.`);
    }

    // ── 4. Select target environment ─────────────────────────────────────────
    let target: DeployTarget;
    if (flags.target) {
      const wanted = flags.target.toLowerCase();
      const found = targets.find(
        (t) => t.environment.toLowerCase() === wanted || t.slug.toLowerCase() === wanted,
      );
      if (!found) {
        this.error(
          `Target "${flags.target}" not found. Available: ${targets.map((t) => t.environment).join(', ')}.`,
        );
      }
      target = found!;
    } else if (targets.length === 1) {
      target = targets[0];
      this.log(`Target: ${target.environment}`);
    } else {
      const r = await prompts({
        type: 'select',
        name: 'target',
        message: 'Select deploy target:',
        choices: targets.map((t) => ({ title: t.environment, value: t })),
      });
      if (!r.target) process.exit(0);
      target = r.target as DeployTarget;
    }

    const envConfig = await fetchEnvironmentConfig(token, owner, repoName, target.environment);
    if (envConfig.allowedMethods.length > 0) {
      this.log(
        `Allowed methods in "${target.environment}": ${envConfig.allowedMethods.join(', ')}`,
      );
      releases = filterReleasesByMethods(releases, envConfig.allowedMethods);
      if (releases.length === 0) {
        this.error(`No releases advertise a deploy method allowed in "${target.environment}".`);
      }
    }

    // ── 5. Select source branch ──────────────────────────────────────────────
    const groups = groupBySourceBranch(releases, branchOf, remoteBranches, current, defaultBranch);
    let group: (typeof groups)[number];
    if (flags.branch) {
      const wanted = stripReleasePrefix(flags.branch);
      const found = groups.find((g) => g.branch === wanted);
      if (!found) {
        this.error(
          `No deployable releases from branch "${wanted}". Available: ${groups.map((g) => g.branch).join(', ')}.`,
        );
      }
      group = found!;
    } else if (groups.length === 1) {
      group = groups[0];
      this.log(`Branch: ${group.branch}`);
    } else {
      // groupBySourceBranch puts the current branch first (else the default one).
      const r = await prompts({
        type: 'select',
        name: 'group',
        message: 'Select branch:',
        choices: groups.map((g) => ({
          title: g.exists ? g.branch : `${g.branch} (deleted)`,
          value: g,
        })),
        initial: 0,
      });
      if (!r.group) process.exit(0);
      group = r.group as (typeof groups)[number];
    }
    releases = group.releases;

    // ── 6. Select version ────────────────────────────────────────────────────
    // One version across all packages — it decides which packages are available.
    const versions = distinctVersions(releases);
    let versionRelease: GHRelease | undefined;
    if (flags.version) {
      versionRelease = resolveVersionKeyword(flags.version, versions);
      if (!versionRelease) {
        this.error(`No release found on ${group.branch} matching version "${flags.version}".`);
      }
    } else {
      let showAllVersions = false;
      while (!versionRelease) {
        const r = await prompts({
          type: 'select',
          name: 'release',
          message: 'Select version:',
          choices: buildVersionChoices(versions, showAllVersions),
        });
        if (!r.release) process.exit(0);
        if (r.release === LOAD_MORE) {
          showAllVersions = true;
          continue;
        }
        versionRelease = r.release as GHRelease;
      }
    }
    const version = versionFromTag(versionRelease!.tag_name);
    const byPackage = packagesAtVersion(releases, version);
    const packageNames = Object.keys(byPackage).sort();

    // ── 7. Select packages ───────────────────────────────────────────────────
    let selectedPackages: string[];
    if (flags.package && flags.package.length > 0) {
      for (const p of flags.package) {
        if (!byPackage[p]) {
          this.error(
            `Package "${p}" has no deployable ${version} release. Available: ${packageNames.join(', ')}.`,
          );
        }
      }
      selectedPackages = flags.package;
    } else if (packageNames.length === 1) {
      selectedPackages = packageNames;
      this.log(`Package: ${selectedPackages[0]}`);
    } else {
      const r = await prompts({
        type: 'multiselect',
        name: 'packages',
        message: `Select packages to deploy at ${version}:`,
        choices: packageNames.map((p) => ({ title: p, value: p })),
        min: 1,
      });
      if (!r.packages || (r.packages as string[]).length === 0) process.exit(0);
      selectedPackages = r.packages as string[];
    }

    // ── 8. Select deploy method for each package ─────────────────────────────
    const dispatches: { pkg: string; release: GHRelease; method: string }[] = [];

    for (const pkg of selectedPackages) {
      const release = byPackage[pkg];
      const releaseMethods = releaseDeployMethods(release);
      // Intersect with the environment allowlist if one is configured.
      const methods =
        envConfig.allowedMethods.length > 0
          ? releaseMethods.filter((m) => envConfig.allowedMethods.includes(m))
          : releaseMethods;
      if (methods.length === 0) {
        this.warn(
          `No allowed deploy methods for ${pkg} ${versionFromTag(release.tag_name)} ` +
            `in "${target.environment}". ` +
            `Release advertises: ${releaseMethods.join(', ')}. ` +
            `Allowed: ${envConfig.allowedMethods.join(', ')}. Skipping.`,
        );
        continue;
      }
      let method: string;

      if (flags.method) {
        if (!releaseMethods.includes(flags.method)) {
          this.error(
            `Method "${flags.method}" not available for ${pkg} ${versionFromTag(release.tag_name)}. Available: ${releaseMethods.join(', ')}.`,
          );
        }
        if (
          envConfig.allowedMethods.length > 0 &&
          !envConfig.allowedMethods.includes(flags.method)
        ) {
          this.error(
            `Method "${flags.method}" is not allowed in environment "${target.environment}". Allowed: ${envConfig.allowedMethods.join(', ')}.`,
          );
        }
        method = flags.method;
      } else if (methods.length === 1) {
        method = methods[0];
      } else {
        // Pre-select: environment DEPLOY_TYPE_DEFAULT > first advertised method
        const dflt =
          envConfig.defaultMethod && methods.includes(envConfig.defaultMethod)
            ? envConfig.defaultMethod
            : defaultMethod(methods);
        const r = await prompts({
          type: 'select',
          name: 'method',
          message: `Select deploy method for ${pkg} ${versionFromTag(release.tag_name)}:`,
          choices: methods.map((m) => ({ title: m, value: m })),
          initial: dflt ? methods.indexOf(dflt) : 0,
        });
        if (!r.method) process.exit(0);
        method = r.method as string;
      }

      dispatches.push({ pkg, release, method });
    }

    // ── 9. Resolve the ref the workflow runs on ──────────────────────────────
    // release/<source> → <source> → current branch → default branch; a ref only
    // counts when it is on origin and carries the target's workflow file.
    let ref = flags.ref;
    if (!ref) {
      for (const candidate of dispatchRefCandidates(group.branch, current, defaultBranch)) {
        if (!remoteBranches.includes(candidate)) continue;
        if (await refHasWorkflow(token, owner, repoName, candidate, target.workflowFile)) {
          ref = candidate;
          break;
        }
      }
      if (!ref) {
        this.error(
          `No branch on origin carries ${target.workflowFile} for ${group.branch}. Use --ref to specify one.`,
        );
      }
    }

    // ── 10. Confirm ──────────────────────────────────────────────────────────
    if (!flags.yes) {
      this.log('\nDeploy plan:');
      this.log(`  Source branch: ${group.branch}${group.exists ? '' : ' (deleted)'}`);
      this.log(`  Workflow ref:  ${ref}`);
      for (const d of dispatches) {
        this.log(
          `  ${d.pkg}  ${versionFromTag(d.release.tag_name)}  [${d.method}]  →  ${target.environment}`,
        );
      }
      const r = await prompts({
        type: 'confirm',
        name: 'ok',
        message: `Dispatch ${dispatches.length} workflow run(s)?`,
        initial: true,
      });
      if (!r.ok) {
        this.log('Cancelled.');
        process.exit(0);
      }
    }

    // ── 11. Dispatch ─────────────────────────────────────────────────────────
    // Build the deploy env string: files first (lower priority), --set last (higher).
    const envFileParts: string[] = [];
    for (const f of flags['env-file'] ?? []) {
      try {
        envFileParts.push(readFileSync(f, 'utf-8').trim());
      } catch (err) {
        this.error(`Cannot read env file "${f}": ${(err as Error).message}`);
      }
    }
    const setParts = flags.set ?? [];
    const allParts = [...envFileParts, ...setParts];
    const deployEnv = allParts.length ? allParts.join('\n') : undefined;

    for (const d of dispatches) {
      const url = await dispatchWorkflow(
        token,
        owner,
        repoName,
        target,
        ref!,
        d.release.id,
        d.method,
        deployEnv,
      );
      this.log(
        `✅ Dispatched: ${d.pkg} ${versionFromTag(d.release.tag_name)} [${d.method}] → ${target.environment}`,
      );
      this.log(`   ${url}`);
    }
  }
}
