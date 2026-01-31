import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);

// src/index.ts
import * as core from "@actions/core";
import * as github from "@actions/github";
import { extractPRMetadata } from "@cpdevtools/git-flow/build-pack";
import { runPublishRelease } from "@cpdevtools/git-flow/publish-release";
async function run() {
  try {
    const prNumber = parseInt(core.getInput("pr-number", { required: true }));
    const githubToken = core.getInput("token", { required: true });
    const { owner, repo } = github.context.repo;
    const sha = github.context.sha;
    const octokit = github.getOctokit(githubToken);
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber
    });
    if (!pr.body) {
      throw new Error(`PR #${prNumber} has no description`);
    }
    const metadata = extractPRMetadata(pr.body);
    const projects = metadata.projects.map((proj) => ({
      name: proj.name,
      version: proj.version,
      releaseTag: `${proj.name}/v${proj.version}`
    }));
    core.info(`Publishing ${projects.length} projects from PR #${prNumber}`);
    const result = await runPublishRelease({
      workspaceRoot: process.cwd(),
      prNumber,
      githubToken,
      owner,
      repo,
      sha,
      projects
    });
    core.setOutput("published-count", result.published.length);
    core.setOutput("verified-count", result.verified.length);
    core.setOutput("failed-count", result.failed.length);
    if (result.failed.length > 0) {
      core.setFailed(`${result.failed.length} projects failed to publish`);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}
run();
