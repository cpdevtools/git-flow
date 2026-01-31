import * as core from '@actions/core';
import * as github from '@actions/github';
import { extractPRMetadata } from '../../packages/git-flow/src/build-pack/index.js';
import { runPublishRelease } from '../../packages/git-flow/src/publish-release/index.js';

async function run() {
  try {
    const prNumber = parseInt(core.getInput('pr-number', { required: true }));
    const githubToken = core.getInput('token', { required: true });

    // Extract repository info from GitHub context
    const { owner, repo } = github.context.repo;
    const sha = github.context.sha;

    // Fetch PR body to extract metadata
    const octokit = github.getOctokit(githubToken);
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    if (!pr.body) {
      throw new Error(`PR #${prNumber} has no description`);
    }

    // Extract PR metadata (project list, versions, etc.)
    const metadata = extractPRMetadata(pr.body);

    // Convert metadata to project list for publish
    const projects = metadata.projects.map(proj => ({
      name: proj.name,
      version: proj.version,
      releaseTag: `${proj.name}/v${proj.version}`,
    }));

    core.info(`Publishing ${projects.length} projects from PR #${prNumber}`);

    // Registry tokens come from environment variables
    // Workflow sets: env: { NPM_TOKEN: ${{ secrets.NPM_TOKEN }}, ... }
    // No need to extract them here - runPublishRelease reads process.env directly

    const result = await runPublishRelease({
      workspaceRoot: process.cwd(),
      prNumber,
      githubToken,
      owner,
      repo,
      sha,
      projects,
    });

    core.setOutput('published-count', result.published.length);
    core.setOutput('verified-count', result.verified.length);
    core.setOutput('failed-count', result.failed.length);

    if (result.failed.length > 0) {
      core.setFailed(`${result.failed.length} projects failed to publish`);
    }
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();
