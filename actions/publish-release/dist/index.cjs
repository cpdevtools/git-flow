var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/index.ts
var core = __toESM(require("@actions/core"), 1);
var github = __toESM(require("@actions/github"), 1);
var import_build_pack = require("@cpdevtools/git-flow/build-pack");
var import_publish_release = require("@cpdevtools/git-flow/publish-release");
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
    const metadata = (0, import_build_pack.extractPRMetadata)(pr.body);
    const projects = metadata.projects.map((proj) => ({
      name: proj.name,
      version: proj.version,
      releaseTag: `${proj.name}/v${proj.version}`
    }));
    core.info(`Publishing ${projects.length} projects from PR #${prNumber}`);
    const result = await (0, import_publish_release.runPublishRelease)({
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
//# sourceMappingURL=index.cjs.map