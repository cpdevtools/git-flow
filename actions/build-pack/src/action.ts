/**
 * GitHub Action entry point for Phase 2 Build & Pack workflow
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import { resolve } from 'node:path';
import { runBuildPack, cleanupEmptyDraftReleases } from '@cpdevtools/git-flow/build-pack';

async function run(): Promise<void> {
  try {
    // Get inputs - read from environment variables directly since we run tsx from workspace root
    const prNumber = parseInt(process.env['INPUT_PR-NUMBER'] || process.env.INPUT_PR_NUMBER || '0', 10);
    const token = process.env['INPUT_TOKEN'] || process.env.GITHUB_TOKEN || '';
    const workspaceRoot = process.env['INPUT_WORKSPACE-ROOT'] || process.env.INPUT_WORKSPACE_ROOT || process.cwd();

    // Validate inputs
    if (isNaN(prNumber) || prNumber < 0) {
      throw new Error(`Invalid PR number: ${core.getInput('pr-number')}`);
    }
    
    const isManualDispatch = prNumber === 0;

    // Get GitHub context
    const sha = process.env.GITHUB_SHA || '';
    const runNumber = parseInt(process.env.GITHUB_RUN_NUMBER || '0', 10);

    if (!sha) {
      throw new Error('GITHUB_SHA environment variable not set');
    }

    if (!runNumber) {
      throw new Error('GITHUB_RUN_NUMBER environment variable not set');
    }

    // Fetch PR body (skip for manual dispatch)
    const octokit = github.getOctokit(token);
    const [owner, repo] = (process.env.GITHUB_REPOSITORY || '/').split('/');
    
    let prBody = '';
    if (!isManualDispatch) {
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });

      if (!pr.body) {
        throw new Error(`PR #${prNumber} has no description`);
      }
      prBody = pr.body;
    } else {
      // For manual dispatch, create a default body with YAML metadata
      prBody = `Manual dispatch from commit ${sha.substring(0, 7)}

\`\`\`yaml
runNumber: ${runNumber}
sha: ${sha}
timestamp: ${new Date().toISOString()}
sourceBranch: main
projects:
  - name: @cpdevtools/git-flow
    version: 0.0.0-DEFAULT
    path: packages/git-flow
    releaseType: dev
\`\`\``;
    }

    // Run build & pack workflow
    core.info(`Starting Build & Pack workflow for PR #${prNumber}`);
    core.info(`Workspace: ${workspaceRoot}`);
    core.info(`SHA: ${sha}`);
    core.info(`Run: ${runNumber}`);

    const result = await runBuildPack(
      {
        workspaceRoot,
        githubToken: token,
        prNumber,
        sha,
        runNumber,
      },
      prBody
    );

    // Set outputs
    core.setOutput('projects-built', result.built.length);
    core.setOutput('projects-packed', result.packed.length);
    core.setOutput('projects-uploaded', result.uploaded.length);
    core.setOutput('projects-skipped', result.skipped.length);

    // Log summary
    const repoUrl = `https://github.com/${owner}/${repo}`;
    const prLink = !isManualDispatch ? `[PR #${prNumber}](${repoUrl}/pull/${prNumber})` : '_manual dispatch_';

    core.summary.addHeading('Build & Pack Results');

    if (result.releases.length > 0) {
      core.summary.addHeading('Draft Releases', 3);
      core.summary.addRaw(
        result.releases.map((r) => `- **${r.name}** [${r.version}](${r.url})`).join('\n') + '\n',
        true,
      );
    }

    core.summary
      .addTable([
        [{ data: 'Phase', header: true }, { data: 'Count', header: true }],
        ['Built', result.built.length.toString()],
        ['Packed', result.packed.length.toString()],
        ['Uploaded', result.uploaded.length.toString()],
        ['Skipped', result.skipped.length.toString()],
        ['Failed', result.failed.length.toString()],
      ])
      .addRaw(`\n**Triggered by:** ${prLink}\n`, true);

    if (result.failed.length > 0) {
      core.summary.addHeading('Failed Projects', 3);
      for (const failure of result.failed) {
        const rawError = failure.error || 'Unknown error';
        // Strip ANSI for the headline (plain text), keep for the code block (ansi lang)
        // eslint-disable-next-line no-control-regex
        const cleanHeadline = rawError.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, '');
        const errorLines = cleanHeadline
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /error|Error|failed|exit code/i.test(l) && l.length > 0)
          .slice(0, 5)
          .join('\n');
        core.summary.addRaw(
          `<details><summary>❌ <strong>${failure.project}</strong>${errorLines ? ` — ${errorLines.split('\n')[0].slice(0, 120)}` : ''}</summary>\n\n` +
          `\`\`\`ansi\n${rawError.trim().slice(0, 8000)}\n\`\`\`\n\n</details>\n`,
          true,
        );
      }
    }

    await core.summary.write();

    // Fail if any projects failed
    if (result.failed.length > 0) {
      await cleanupEmptyDraftReleases(token, owner, repo, runNumber);
      core.setFailed(`${result.failed.length} project(s) failed`);
    } else {
      core.info(`✅ All projects completed successfully`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Best-effort cleanup of empty drafts left by this run
    try {
      const token = process.env['INPUT_TOKEN'] || process.env.GITHUB_TOKEN || '';
      const [owner, repo] = (process.env.GITHUB_REPOSITORY || '/').split('/');
      const runNumber = parseInt(process.env.GITHUB_RUN_NUMBER || '0', 10);
      if (token && owner && repo && runNumber) {
        await cleanupEmptyDraftReleases(token, owner, repo, runNumber);
      }
    } catch (cleanupErr) {
      core.warning(`Cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    }

    core.setFailed(`Build & Pack workflow failed: ${errorMessage}`);
    
    if (error instanceof Error && error.stack) {
      core.debug(error.stack);
    }
  }
}

run();
