/**
 * GitHub Action entry point for Phase 2 Build & Pack workflow
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import { resolve } from 'node:path';
import { runBuildPack } from '../../packages/git-flow/src/build-pack/index.js';

async function run(): Promise<void> {
  try {
    // Get inputs
    const prNumber = parseInt(core.getInput('pr-number', { required: true }), 10);
    const token = core.getInput('token', { required: true });
    const workspaceRoot = core.getInput('workspace-root', { required: false }) || process.cwd();
    const artifactOutputDirInput = core.getInput('artifact-output-dir', { required: false }) || '.artifacts';
    // Resolve to absolute path relative to workspace root
    const artifactOutputDir = resolve(workspaceRoot, artifactOutputDirInput);

    // Validate inputs
    if (isNaN(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid PR number: ${core.getInput('pr-number')}`);
    }

    // Get GitHub context
    const sha = process.env.GITHUB_SHA || '';
    const runNumber = parseInt(process.env.GITHUB_RUN_NUMBER || '0', 10);

    if (!sha) {
      throw new Error('GITHUB_SHA environment variable not set');
    }

    if (!runNumber) {
      throw new Error('GITHUB_RUN_NUMBER environment variable not set');
    }

    // Fetch PR body
    const octokit = github.getOctokit(token);
    const [owner, repo] = (process.env.GITHUB_REPOSITORY || '/').split('/');
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    if (!pr.body) {
      throw new Error(`PR #${prNumber} has no description`);
    }

    // Run build & pack workflow
    core.info(`Starting Build & Pack workflow for PR #${prNumber}`);
    core.info(`Workspace: ${workspaceRoot}`);
    core.info(`Artifact output: ${artifactOutputDir}`);
    core.info(`SHA: ${sha}`);
    core.info(`Run: ${runNumber}`);

    const result = await runBuildPack(
      {
        workspaceRoot,
        artifactOutputDir,
        githubToken: token,
        prNumber,
        sha,
        runNumber,
      },
      pr.body
    );

    // Set outputs
    core.setOutput('projects-built', result.built.length);
    core.setOutput('projects-packed', result.packed.length);
    core.setOutput('projects-uploaded', result.uploaded.length);
    core.setOutput('projects-skipped', result.skipped.length);

    // Log summary
    core.summary
      .addHeading('Build & Pack Results')
      .addTable([
        [{ data: 'Phase', header: true }, { data: 'Count', header: true }],
        ['Built', result.built.length.toString()],
        ['Packed', result.packed.length.toString()],
        ['Uploaded', result.uploaded.length.toString()],
        ['Skipped', result.skipped.length.toString()],
        ['Failed', result.failed.length.toString()],
      ]);

    if (result.failed.length > 0) {
      core.summary.addHeading('Failed Projects', 3);
      for (const failure of result.failed) {
        core.summary.addRaw(`- ${failure.project}: ${failure.error || 'Unknown error'}`, true);
      }
    }

    await core.summary.write();

    // Fail if any projects failed
    if (result.failed.length > 0) {
      core.setFailed(`${result.failed.length} project(s) failed`);
    } else {
      core.info(`✅ All projects completed successfully`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Build & Pack workflow failed: ${errorMessage}`);
    
    if (error instanceof Error && error.stack) {
      core.debug(error.stack);
    }
  }
}

run();
