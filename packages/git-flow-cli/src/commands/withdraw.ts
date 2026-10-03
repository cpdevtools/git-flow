/**
 * gitflow withdraw — hide a release (or every release of a package) from
 * `gitflow deploy`, mark it on GitHub, and dispatch the repository's
 * withdraw.yml workflow for the parts that need registry credentials.
 *
 *   gitflow withdraw @org/orders@1.4.2 --kind broken --reason "double charge"
 *   gitflow withdraw @org/legacy-svc@all --kind obsolete --reason "retired"
 *   gitflow withdraw @org/orders@1.4.2 --undo
 *
 * Like `deploy`, any flag that is not given is prompted for. The marker is
 * written first and never depends on the workflow succeeding.
 */

import { Args, Command, Flags } from '@oclif/core';
import { execSync } from 'node:child_process';
import prompts from 'prompts';
import { parse as parseYaml } from 'yaml';
import {
  KIND_INFO,
  WITHDRAW_KINDS,
  isWithdrawKind,
  readWithdrawal,
  findReleaseByTag,
  listProjectReleases,
  markReleaseWithdrawn,
  clearReleaseWithdrawn,
  type AssetsEffect,
  type RegistryEffect,
  type ReleaseSummary,
  type Withdrawal,
  type WithdrawKind,
} from '@cpdevtools/git-flow/withdraw';
import { fetchDefaultBranch, getRepoFromRemote, gh } from './deploy-helpers.js';

const REGISTRY_EFFECTS: RegistryEffect[] = ['mark', 'delete', 'none'];
const ASSETS_EFFECTS: AssetsEffect[] = ['keep', 'delete'];

/** `@scope/name@1.2.3` → { pkg, version }; `name@all` → { pkg, version: 'all' }. */
export function parseTarget(target: string): { pkg: string; version: string } {
  const at = target.lastIndexOf('@');
  if (at <= 0) {
    throw new Error(`Expected <package>@<version> or <package>@all, got '${target}'`);
  }
  const pkg = target.slice(0, at);
  const version = target.slice(at + 1).replace(/^v/, '');
  if (!pkg || !version) {
    throw new Error(`Expected <package>@<version> or <package>@all, got '${target}'`);
  }
  return { pkg, version };
}

export default class Withdraw extends Command {
  static override description =
    'Withdraw a release: hide it from `gitflow deploy`, mark it on GitHub, and repoint floating tags / mark or delete registry versions through the repository\'s withdraw workflow.';

  static override examples = [
    '<%= config.bin %> withdraw @org/orders@1.4.2',
    '<%= config.bin %> withdraw @org/orders@1.4.2 --kind broken --reason "double-charges discounted orders" --registry mark --assets keep --yes',
    '<%= config.bin %> withdraw @org/orders@1.5.0 --kind superseded --replaced-by 1.5.1',
    '<%= config.bin %> withdraw @org/legacy-service@all --kind obsolete --reason "service retired"',
    '<%= config.bin %> withdraw @org/orders@1.4.2 --undo',
  ];

  static override args = {
    target: Args.string({
      description: '<package>@<version>, or <package>@all for every release of the package',
      required: true,
    }),
  };

  static override flags = {
    repo: Flags.string({
      char: 'r',
      description: 'GitHub repo (owner/repo). Defaults to the current git remote origin.',
    }),
    kind: Flags.string({
      char: 'k',
      description: `Why: ${WITHDRAW_KINDS.join(', ')}. Prompted when omitted.`,
      options: [...WITHDRAW_KINDS],
    }),
    reason: Flags.string({ description: 'One line for the banner. Prompted when omitted.' }),
    'replaced-by': Flags.string({
      description: 'For kind superseded: the version to use instead.',
    }),
    registry: Flags.string({
      description:
        'What to do in the package registries: mark (npm deprecate / NuGet unlist), delete (remove the version), none. Prompted when omitted; default depends on kind.',
      options: REGISTRY_EFFECTS,
    }),
    assets: Flags.string({
      description:
        'What to do with the release assets (deploy bundles, tarballs): keep or delete. Prompted when omitted.',
      options: ASSETS_EFFECTS,
    }),
    undo: Flags.boolean({
      description:
        'Restore a withdrawn release: clear the marker, give its floating tags back, and undo reversible registry marks.',
      default: false,
    }),
    workflow: Flags.string({
      description: 'Workflow file that applies the registry effects.',
      default: 'withdraw.yml',
    }),
    'no-dispatch': Flags.boolean({
      description: 'Only mark the release(s); do not dispatch the workflow.',
      default: false,
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'No prompts: take kind-based defaults and skip the confirmation.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Withdraw);

    const token = process.env['GITHUB_TOKEN'];
    if (!token) this.error('GITHUB_TOKEN environment variable is required.');

    const repo = flags.repo ?? getRepoFromRemote();
    const [owner, repoName] = repo.split('/') as [string, string];
    const { pkg, version } = parseTarget(args.target);
    const all = version === 'all';

    // ── 1. Resolve the release(s) ────────────────────────────────────────────
    let releases: ReleaseSummary[];
    if (all) {
      const every = await listProjectReleases(token, owner, repoName, pkg);
      if (every.length === 0) this.error(`No published releases found for ${pkg} in ${repo}.`);
      releases = every.filter((r) => (flags.undo ? readWithdrawal(r.body) : !readWithdrawal(r.body)));
      if (releases.length === 0) {
        this.log(flags.undo ? 'Nothing to restore.' : 'Every release is already withdrawn.');
        return;
      }
    } else {
      const tag = `${pkg}/v${version}`;
      const release = await findReleaseByTag(token, owner, repoName, tag);
      if (!release) this.error(`No release tagged ${tag} in ${repo}.`);
      if (release.draft) this.error(`${tag} is still a draft; withdrawing applies to published releases.`);
      const w = readWithdrawal(release.body);
      if (!flags.undo && w) {
        this.error(`${tag} is already withdrawn (${w.kind}: ${w.reason}). Use --undo to restore it.`);
      }
      if (flags.undo && !w) this.error(`${tag} is not withdrawn.`);
      releases = [release];
    }

    // ── 2. @all: refuse while the artifact is still declared on mainline ─────
    if (all && !flags.undo) {
      const declaredAt = await findDeclaration(token, owner, repoName, pkg);
      if (declaredAt) {
        this.error(
          `${pkg} is still declared in ${declaredAt} on the default branch. ` +
            `Retiring every release of a package that the next release PR would publish again is a ` +
            `contradiction: remove the artifact (or the project) there first, then withdraw.`,
        );
      }
    }

    // ── 3. Undo ──────────────────────────────────────────────────────────────
    if (flags.undo) {
      for (const r of releases) {
        const restored = await clearReleaseWithdrawn(token, owner, repoName, r);
        this.log(`♻️  restored ${restored.tag_name}  ${restored.html_url}`);
      }
      await this.dispatch(token, owner, repoName, flags.workflow, flags['no-dispatch'], {
        release_ids: releases.map((r) => String(r.id)).join(','),
        registry: 'none',
        assets: 'keep',
        undo: 'true',
      });
      return;
    }

    // ── 4. Kind, reason, effects — flags or prompts ──────────────────────────
    const kind = await this.resolveKind(flags.kind, flags.yes);
    const info = KIND_INFO[kind];
    const reason = await this.resolveReason(flags.reason, flags.yes);
    const replacedBy = await this.resolveReplacedBy(kind, flags['replaced-by'], flags.yes);
    const registry = await this.resolveChoice<RegistryEffect>(
      'registry',
      flags.registry as RegistryEffect | undefined,
      REGISTRY_EFFECTS,
      info.registry,
      'Registry effect (mark = npm deprecate / NuGet unlist, delete = remove the version)',
      flags.yes,
    );
    const assets = await this.resolveChoice<AssetsEffect>(
      'assets',
      flags.assets as AssetsEffect | undefined,
      ASSETS_EFFECTS,
      info.assets,
      'Release assets (deploy bundles, tarballs)',
      flags.yes,
    );

    const by = await whoAmI(token);
    const withdrawal: Withdrawal = {
      kind,
      reason,
      at: new Date().toISOString(),
      by,
      ...(replacedBy ? { replacedBy } : {}),
      registry: registry === 'none' ? 'none' : 'pending',
      assets: assets === 'delete' ? 'pending' : 'kept',
    };

    // ── 5. Confirm ───────────────────────────────────────────────────────────
    this.log('');
    this.log(`Withdraw ${releases.length} release(s) of ${pkg}:`);
    for (const r of releases) this.log(`  • ${r.tag_name}`);
    this.log(`  kind:     ${kind} — ${info.summary}`);
    this.log(`  reason:   ${reason}`);
    if (replacedBy) this.log(`  use:      ${replacedBy}`);
    this.log(`  registry: ${registry}`);
    this.log(`  assets:   ${assets}`);
    if (!flags.yes) {
      const r = await prompts({ type: 'confirm', name: 'ok', message: 'Proceed?', initial: true });
      if (!r.ok) {
        this.log('Cancelled.');
        return;
      }
    }

    // ── 6. Mark — first, and independent of everything after ─────────────────
    for (const r of releases) {
      const marked = await markReleaseWithdrawn(token, owner, repoName, r, withdrawal);
      this.log(`⛔ withdrawn ${marked.tag_name}  ${marked.html_url}`);
    }

    // ── 7. Dispatch the workflow for floating tags + registry effects ───────
    await this.dispatch(token, owner, repoName, flags.workflow, flags['no-dispatch'], {
      release_ids: releases.map((r) => String(r.id)).join(','),
      registry,
      assets,
      undo: 'false',
    });
  }

  private async resolveKind(given: string | undefined, yes: boolean): Promise<WithdrawKind> {
    if (given) {
      if (!isWithdrawKind(given)) this.error(`Unknown kind '${given}'. Use one of: ${WITHDRAW_KINDS.join(', ')}.`);
      return given;
    }
    if (yes) this.error('--kind is required with --yes.');
    const r = await prompts({
      type: 'select',
      name: 'kind',
      message: 'Why is it being withdrawn?',
      choices: WITHDRAW_KINDS.map((k) => ({
        title: k.padEnd(11) + KIND_INFO[k].summary,
        value: k,
      })),
    });
    if (!r.kind) this.exit(0);
    return r.kind as WithdrawKind;
  }

  private async resolveReason(given: string | undefined, yes: boolean): Promise<string> {
    if (given?.trim()) return given.trim();
    if (yes) this.error('--reason is required with --yes.');
    const r = await prompts({
      type: 'text',
      name: 'reason',
      message: 'Reason (one line, shown on the release and in the picker)',
      validate: (v: string) => (v.trim() ? true : 'A reason is required'),
    });
    if (!r.reason) this.exit(0);
    return String(r.reason).trim();
  }

  private async resolveReplacedBy(
    kind: WithdrawKind,
    given: string | undefined,
    yes: boolean,
  ): Promise<string | undefined> {
    if (given) return given.replace(/^v/, '');
    if (kind !== 'superseded' || yes) return undefined;
    const r = await prompts({
      type: 'text',
      name: 'v',
      message: 'Replaced by which version? (blank to skip)',
    });
    const v = String(r.v ?? '').trim();
    return v ? v.replace(/^v/, '') : undefined;
  }

  private async resolveChoice<T extends string>(
    name: string,
    given: T | undefined,
    options: T[],
    initial: T,
    message: string,
    yes: boolean,
  ): Promise<T> {
    if (given) return given;
    if (yes) return initial;
    const r = await prompts({
      type: 'select',
      name,
      message,
      choices: options.map((o) => ({ title: o === initial ? `${o} (default for this kind)` : o, value: o })),
      initial: options.indexOf(initial),
    });
    if (r[name] === undefined) this.exit(0);
    return r[name] as T;
  }

  private async dispatch(
    token: string,
    owner: string,
    repo: string,
    workflowFile: string,
    skip: boolean,
    inputs: Record<string, string>,
  ): Promise<void> {
    if (skip) {
      this.log('Workflow not dispatched (--no-dispatch). Floating tags and registries are unchanged.');
      return;
    }
    const ref = await fetchDefaultBranch(token, owner, repo);
    try {
      await gh(token, `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}`);
    } catch {
      this.warn(
        `${workflowFile} not found on ${ref}. The release(s) are marked, but floating tags and ` +
          `registry effects were not applied. Add the workflow from git-flow-template ` +
          `(.github/workflows/withdraw.yml.example) and re-run with the same arguments, or run it by hand.`,
      );
      return;
    }
    await gh(
      token,
      `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, inputs }),
      },
    );
    this.log(
      `🚀 dispatched ${workflowFile} on ${ref}: https://github.com/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}`,
    );
  }
}

/** GitHub login behind the token, falling back to the git user name. */
async function whoAmI(token: string): Promise<string> {
  try {
    const me = await gh<{ login?: string }>(token, '/user');
    if (me?.login) return me.login;
  } catch {
    // app tokens have no /user
  }
  try {
    return execSync('git config user.name', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Path of the release-artifacts.yml (or project package.json) on the default
 * branch that still declares `pkg`, or undefined when nothing does.
 */
async function findDeclaration(
  token: string,
  owner: string,
  repo: string,
  pkg: string,
): Promise<string | undefined> {
  const branch = await fetchDefaultBranch(token, owner, repo);
  const tree = await gh<{ tree: { path: string; type: string }[]; truncated: boolean }>(
    token,
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  const files = tree?.tree.filter((t) => t.type === 'blob') ?? [];
  const manifests = files.filter((t) => /(^|\/)release-artifacts\.ya?ml$/.test(t.path));
  for (const m of manifests) {
    const dir = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : '';
    const pkgJsonPath = dir ? `${dir}/package.json` : 'package.json';
    const [manifest, pkgJson] = await Promise.all([
      readFile(token, owner, repo, branch, m.path),
      readFile(token, owner, repo, branch, pkgJsonPath),
    ]);
    if (pkgJson) {
      try {
        if ((JSON.parse(pkgJson) as { name?: string }).name === pkg) return pkgJsonPath;
      } catch {
        // not JSON; ignore
      }
    }
    if (manifest) {
      try {
        const parsed = parseYaml(manifest) as { artifacts?: { name?: string }[] } | null;
        if (parsed?.artifacts?.some((a) => a.name === pkg)) return m.path;
      } catch {
        // not YAML; ignore
      }
    }
  }
  return undefined;
}

async function readFile(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<string | undefined> {
  try {
    const res = await gh<{ content?: string; encoding?: string }>(
      token,
      `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
    );
    if (!res?.content) return undefined;
    return Buffer.from(res.content, (res.encoding as BufferEncoding) ?? 'base64').toString('utf-8');
  } catch {
    return undefined;
  }
}
