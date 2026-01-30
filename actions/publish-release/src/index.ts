import * as core from '@actions/core';
import * as github from '@actions/github';
import { runPublishRelease } from '@cpdevtools/git-flow/publish-release';

async function run() {
  try {
    const prNumber = parseInt(core.getInput('pr-number', { required: true }));
    const githubToken = core.getInput('token', { required: true });

    // Extract repository info from GitHub context
    const { owner, repo } = github.context.repo;
    const sha = github.context.sha;

    // TODO: Extract PR metadata to get project list
    // For now, using placeholder
    const projects = [
      {
        name: 'example-project',
        version: '1.0.0',
        releaseTag: 'example-project/v1.0.0',
      },
    ];

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
