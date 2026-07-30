/**
 * gitflow deploy
 *
 * Interactive CLI to select a deploy target (environment), package, and version,
 * then dispatch the corresponding per-environment deploy workflow via the GitHub API.
 *
 * Required env vars:
 *   GITHUB_TOKEN — PAT with actions:write + contents:read
 *
 * Every prompt is short-circuitable via flags:
 *   --branch  -b  Release branch to scan for deploy workflows
 *   --target  -t  Target environment (e.g. production, dev)
 *   --package -p  Package name(s) to deploy (repeatable)
 *   --version -v  Version to deploy: semver, "latest", or "next"
 *   --method  -m  Deploy method (e.g. node, compose, swarm)
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
  packageFromTag,
  parseRepoFromUrl,
  compareVersions,
  groupByPackage,
  resolveVersionKeyword,
  buildVersionChoices,
  isDeployable,
  releaseDeployMethods,
  defaultMethod,
  parseWorkflowEnvironment,
} from './deploy-helpers.js';

interface DeployTarget {
  /** GitHub Environment name (from the workflow's `jobs.deploy.environment`). */
  environment: string;
  /** Filename slug fallback (e.g. `deploy-test` from `deploy-deploy-test.yml`). */
  slug: string;
  workflowFile: string;
}

// ─── GitHub API helper ────────────────────────────────────────────────────────

async function gh<T = unknown>(token: string, path: string, options?: RequestInit): Promise<T | null> {
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

async function discoverReleaseBranch(
  token: string,
  owner: string,
  repo: string,
): Promise<string> {
  const current = getCurrentBranch();
  if (current.startsWith('release/')) return current;

  // Try release/<current-branch> by convention
  const candidate = `release/${current}`;
  try {
    await gh(token, `/repos/${owner}/${repo}/git/ref/heads/${candidate}`);
    return candidate;
  } catch {
    // Candidate doesn't exist — fall through to list
  }

  const branches = await gh<{ name: string }[]>(
    token,
    `/repos/${owner}/${repo}/branches?per_page=100`,
  );
  const releaseBranches = (branches ?? [])
    .filter((b) => b.name.startsWith('release/'))
    .map((b) => b.name);

  if (releaseBranches.length === 0) {
    throw new Error(
      `No release/* branches found in ${owner}/${repo}. Use --branch to specify one.`,
    );
  }
  if (releaseBranches.length === 1) return releaseBranches[0];

  const r = await prompts({
    type: 'select',
    name: 'branch',
    message: 'Select release branch:',
    choices: releaseBranches.map((b) => ({ title: b, value: b })),
  });
  if (!r.branch) process.exit(0);
  return r.branch as string;
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
          const yml = Buffer.from(file.content, (file.encoding as BufferEncoding) ?? 'base64').toString('utf-8');
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
      if (isDeployable(r)) results.push(r);
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
    'Interactive deploy — select an environment, package, and version, then dispatch the deploy workflow.';

  static override examples = [
    '<%= config.bin %> deploy',
    '<%= config.bin %> deploy --target production --package @org/svc --version latest',
    '<%= config.bin %> deploy --target production --package @org/svc --version next --yes',
    '<%= config.bin %> deploy --repo owner/repo --branch release/main --target dev --yes',
  ];

  static override flags = {
    repo: Flags.string({
      char: 'r',
      description: 'GitHub repo (owner/repo). Defaults to the current git remote origin.',
    }),
    branch: Flags.string({
      char: 'b',
      description:
        'Release branch to scan for deploy workflows (e.g. release/main). Defaults to release/<current-branch>.',
    }),
    target: Flags.string({
      char: 't',
      description: 'Deploy target environment (e.g. production, dev). Skips environment prompt.',
    }),
    package: Flags.string({
      char: 'p',
      description: 'Package(s) to deploy. Repeatable. Skips package selection prompt.',
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
      description: 'Per-run deploy env override as KEY=VAL (e.g. --set COMPOSE_FILE=docker-compose.netns.yml). Repeatable.',
      multiple: true,
    }),
    'env-file': Flags.string({
      char: 'e',
      description: 'File of KEY=VAL lines to merge as deploy env. Repeatable; later files override earlier ones.',
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

    // ── 2. Resolve release branch ────────────────────────────────────────────
    const branch = flags.branch ?? (await discoverReleaseBranch(token, owner, repoName));
    this.log(`Release branch: ${branch}`);

    // ── 3. Discover deploy targets ───────────────────────────────────────────
    const targets = await discoverDeployTargets(token, owner, repoName, branch);
    if (targets.length === 0) {
      this.error(
        `No deploy workflows found on ${branch}. Expected files matching deploy-*.yml.`,
      );
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

    // ── 5. List deployable releases ──────────────────────────────────────────
    this.log('Fetching releases...');
    const releases = await listDeployableReleases(token, owner, repoName);
    if (releases.length === 0) {
      this.error('No deployable releases found (no published releases advertising a deploy method).');
    }

    const byPackage = groupByPackage(releases);
    const packageNames = Object.keys(byPackage).sort();

    // ── 6. Select packages ───────────────────────────────────────────────────
    let selectedPackages: string[];
    if (flags.package && flags.package.length > 0) {
      for (const p of flags.package) {
        if (!byPackage[p]) {
          this.error(`Package "${p}" not found. Available: ${packageNames.join(', ')}.`);
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
        message: 'Select packages to deploy:',
        choices: packageNames.map((p) => ({ title: p, value: p })),
        min: 1,
      });
      if (!r.packages || (r.packages as string[]).length === 0) process.exit(0);
      selectedPackages = r.packages as string[];
    }

    // ── 7. Select version + deploy method for each package ──────────────────
    const dispatches: { pkg: string; release: GHRelease; method: string }[] = [];

    for (const pkg of selectedPackages) {
      const pkgReleases = byPackage[pkg];
      let selected: GHRelease | undefined;

      if (flags.version) {
        selected = resolveVersionKeyword(flags.version, pkgReleases);
        if (!selected) {
          this.error(`No release found for ${pkg} matching version "${flags.version}".`);
        }
      } else {
        const r = await prompts({
          type: 'select',
          name: 'release',
          message: `Select version for ${pkg}:`,
          choices: buildVersionChoices(pkgReleases),
        });
        if (!r.release) process.exit(0);
        selected = r.release as GHRelease;
      }

      const release = selected!;
      const methods = releaseDeployMethods(release);
      let method: string;

      if (flags.method) {
        if (!methods.includes(flags.method)) {
          this.error(
            `Method "${flags.method}" not available for ${pkg} ${versionFromTag(release.tag_name)}. Available: ${methods.join(', ')}.`,
          );
        }
        method = flags.method;
      } else if (methods.length === 1) {
        method = methods[0];
      } else {
        const dflt = defaultMethod(methods);
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

    // ── 8. Confirm ───────────────────────────────────────────────────────────
    if (!flags.yes) {
      this.log('\nDeploy plan:');
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

    // ── 9. Dispatch ──────────────────────────────────────────────────────────
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
        branch,
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
