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
var import_node_path = require("path");
var import_build_pack = require("@cpdevtools/git-flow/build-pack");
async function run() {
  try {
    const prNumber = parseInt(core.getInput("pr-number", { required: true }), 10);
    const token = core.getInput("token", { required: true });
    const workspaceRoot = core.getInput("workspace-root", { required: false }) || process.cwd();
    const artifactOutputDirInput = core.getInput("artifact-output-dir", { required: false }) || ".artifacts";
    const artifactOutputDir = (0, import_node_path.resolve)(workspaceRoot, artifactOutputDirInput);
    if (isNaN(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid PR number: ${core.getInput("pr-number")}`);
    }
    const sha = process.env.GITHUB_SHA || "";
    const runNumber = parseInt(process.env.GITHUB_RUN_NUMBER || "0", 10);
    if (!sha) {
      throw new Error("GITHUB_SHA environment variable not set");
    }
    if (!runNumber) {
      throw new Error("GITHUB_RUN_NUMBER environment variable not set");
    }
    const octokit = github.getOctokit(token);
    const [owner, repo] = (process.env.GITHUB_REPOSITORY || "/").split("/");
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber
    });
    if (!pr.body) {
      throw new Error(`PR #${prNumber} has no description`);
    }
    core.info(`Starting Build & Pack workflow for PR #${prNumber}`);
    core.info(`Workspace: ${workspaceRoot}`);
    core.info(`Artifact output: ${artifactOutputDir}`);
    core.info(`SHA: ${sha}`);
    core.info(`Run: ${runNumber}`);
    const result = await (0, import_build_pack.runBuildPack)(
      {
        workspaceRoot,
        artifactOutputDir,
        githubToken: token,
        prNumber,
        sha,
        runNumber
      },
      pr.body
    );
    core.setOutput("projects-built", result.built.length);
    core.setOutput("projects-packed", result.packed.length);
    core.setOutput("projects-uploaded", result.uploaded.length);
    core.setOutput("projects-skipped", result.skipped.length);
    core.summary.addHeading("Build & Pack Results").addTable([
      [{ data: "Phase", header: true }, { data: "Count", header: true }],
      ["Built", result.built.length.toString()],
      ["Packed", result.packed.length.toString()],
      ["Uploaded", result.uploaded.length.toString()],
      ["Skipped", result.skipped.length.toString()],
      ["Failed", result.failed.length.toString()]
    ]);
    if (result.failed.length > 0) {
      core.summary.addHeading("Failed Projects", 3);
      for (const failure of result.failed) {
        core.summary.addRaw(`- ${failure.project}: ${failure.error || "Unknown error"}`, true);
      }
    }
    await core.summary.write();
    if (result.failed.length > 0) {
      core.setFailed(`${result.failed.length} project(s) failed`);
    } else {
      core.info(`\u2705 All projects completed successfully`);
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
//# sourceMappingURL=index.cjs.map