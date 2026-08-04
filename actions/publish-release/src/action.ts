import * as core from '@actions/core';
import * as github from '@actions/github';
import { extractPRMetadata } from '@cpdevtools/git-flow/build-pack';
import { runPublishRelease } from '@cpdevtools/git-flow/publish-release';

async function run() {
  try {
    // Get inputs - read from environment variables directly since we run tsx from workspace root
    const prNumber = parseInt(process.env['INPUT_PR-NUMBER'] || process.env.INPUT_PR_NUMBER || '0', 10);
    const githubToken = process.env['INPUT_TOKEN'] || process.env.GITHUB_TOKEN || '';

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

    // Flatten grouped projects into single array for publish
    const projects = Object.values(metadata.projectsByPlaceholder)
      .flat()
      .map(proj => ({
        name: proj.name,
        version: proj.version,
        releaseTag: `${proj.name}/v${proj.version}`,
        prerelease: proj.prerelease,
        placeholder: proj.placeholder,
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

    // Mirror the published-releases list (the PR comment) into the step summary.
    if (result.releaseComment) {
      await core.summary.addRaw(result.releaseComment, true).write();
    }

    if (result.failed.length > 0) {
      core.setFailed(`${result.failed.length} projects failed to publish`);
    }
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();
