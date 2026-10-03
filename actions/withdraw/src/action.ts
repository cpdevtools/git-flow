/**
 * GitHub Action entry point for the registry side of `gitflow withdraw`.
 *
 * Reads the inputs the CLI dispatched with and hands them to the library.
 * Registry credentials come from the environment the workflow provides, named
 * by each registry's `auth` in .publish/registries.yml — exactly as
 * publish-release finds them.
 */

import * as core from '@actions/core';
import { applyWithdrawEffects } from '@cpdevtools/git-flow/withdraw';

async function main(): Promise<void> {
  const token = process.env['GITHUB_TOKEN'];
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const [owner, repo] = (process.env['GITHUB_REPOSITORY'] ?? '/').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY is not set');

  const releaseIds = (process.env['INPUT_RELEASE_IDS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid release id '${s}'`);
      return n;
    });
  if (releaseIds.length === 0) throw new Error('release_ids is empty');

  const registry = (process.env['INPUT_REGISTRY'] || 'none') as 'mark' | 'delete' | 'none';
  const assets = (process.env['INPUT_ASSETS'] || 'keep') as 'keep' | 'delete';
  const undo = (process.env['INPUT_UNDO'] ?? 'false') === 'true';
  if (!['mark', 'delete', 'none'].includes(registry)) throw new Error(`Invalid registry '${registry}'`);
  if (!['keep', 'delete'].includes(assets)) throw new Error(`Invalid assets '${assets}'`);

  core.info(`${undo ? 'Restoring' : 'Withdrawing'} ${releaseIds.length} release(s): ${releaseIds.join(', ')}`);
  core.info(`registry: ${registry}   assets: ${assets}`);

  const results = await applyWithdrawEffects({
    githubToken: token,
    owner,
    repo,
    workspaceRoot: process.env['INPUT_WORKSPACE_ROOT'] || process.cwd(),
    releaseIds,
    registry,
    assets,
    undo,
    log: (line) => core.info(line),
  });

  const lines = [`## ${undo ? 'Restored' : 'Withdrawn'} releases`, ''];
  lines.push('| Release | Floating tags | Registry | Assets |', '|---|---|---|---|');
  for (const r of results) {
    const tags =
      r.repoints.map((p) => `${p.tag} → ${p.to ?? '(removed)'}`).join('<br>') || 'none held';
    lines.push(`| ${r.project}@${r.version} | ${tags} | ${r.registry} | ${r.assets} |`);
    for (const note of r.notes) core.warning(`${r.project}@${r.version}: ${note}`);
  }
  await core.summary.addRaw(lines.join('\n')).write();
}

main().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
