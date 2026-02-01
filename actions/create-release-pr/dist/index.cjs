"use strict";
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
var import_promises = require("fs/promises");
var import_yaml = require("yaml");
var import_node_path = require("path");
var import_promises2 = require("fs/promises");
var import_promises3 = require("fs/promises");
function parseJson(content) {
  return JSON.parse(content);
}
async function discoverProjects(options) {
  const projects = [];
  async function findPackageJsonFiles(dir) {
    const files = [];
    try {
      const entries = await (0, import_promises2.readdir)(dir);
      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules") continue;
        const fullPath = (0, import_node_path.join)(dir, entry);
        const stats = await (0, import_promises3.stat)(fullPath);
        if (stats.isDirectory()) {
          files.push(...await findPackageJsonFiles(fullPath));
        } else if (entry === "package.json") {
          files.push(fullPath);
        }
      }
    } catch {
    }
    return files;
  }
  const packageJsonFiles = await findPackageJsonFiles(options.cwd);
  for (const file of packageJsonFiles) {
    try {
      const content = await (0, import_promises.readFile)(file, "utf-8");
      const packageJson = parseJson(content);
      projects.push({
        packageJson,
        path: file
      });
    } catch {
    }
  }
  return projects;
}
async function resolveVersion(input) {
  const { placeholder, versionsByPlaceholder, runNumber } = input;
  const resolvedVersion = versionsByPlaceholder[placeholder];
  if (!resolvedVersion) {
    throw new Error(`No version found for placeholder: ${placeholder}`);
  }
  return {
    version: resolvedVersion,
    isPreRelease: resolvedVersion.includes("-")
  };
}
async function run() {
  try {
    core.info("\u{1F680} create-release-pr action v2 - checking GitHub releases for existing versions");
    const branch = core.getInput("branch", { required: true });
    const token = core.getInput("token", { required: true });
    const versionsFile = core.getInput("versions-file") || ".github/versions.json";
    const runNumber = parseInt(core.getInput("run-number") || "0", 10);
    process.env.GITHUB_TOKEN = token;
    core.info(`Token set for gh CLI (length: ${token.length})`);
    core.info(`Creating release PR for branch: ${branch}`);
    core.info(`Run number: ${runNumber}`);
    const versionsContent = await (0, import_promises.readFile)(versionsFile, "utf-8");
    const isYaml = versionsFile.endsWith(".yml") || versionsFile.endsWith(".yaml");
    const versionsByPlaceholder = isYaml ? (0, import_yaml.parse)(versionsContent) : parseJson(versionsContent);
    core.info(`Loaded versions from ${versionsFile}: ${JSON.stringify(versionsByPlaceholder)}`);
    const projects = await discoverProjects({
      cwd: process.cwd(),
      patterns: ["**/package.json", "packages/*/package.json"]
    });
    core.info(`Found ${projects.length} projects`);
    const buildableProjects = projects.filter((project) => {
      const hasBuildScript = !!project.packageJson.scripts?.["github.actions.build"];
      if (!hasBuildScript) {
        core.info(`Skipping ${project.packageJson.name}: no github.actions.build script`);
      }
      return hasBuildScript;
    });
    core.info(`${buildableProjects.length} projects have github.actions.build script`);
    const projectMetadata = [];
    for (const project of buildableProjects) {
      const packageVersion = project.packageJson.version;
      if (!packageVersion) {
        core.warning(`Skipping ${project.packageJson.name}: no version in package.json`);
        continue;
      }
      try {
        const result = await resolveVersion({
          placeholder: packageVersion,
          branch,
          versionsByPlaceholder,
          runNumber,
          projectName: project.packageJson.name
        });
        projectMetadata.push({
          name: project.packageJson.name || "unknown",
          version: packageVersion,
          resolvedVersion: result.version,
          isPreRelease: result.isPreRelease,
          cwd: project.directory
        });
        core.info(
          `${project.packageJson.name}: ${packageVersion} \u2192 ${result.version} (pre-release: ${result.isPreRelease})`
        );
      } catch (error) {
        core.warning(
          `Failed to resolve version for ${project.packageJson.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const releaseBranch = `release/${branch}`;
    core.info(`Release branch: ${releaseBranch}`);
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    const { data: refData } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`
    });
    const sha = refData.object.sha;
    core.info(`Current SHA: ${sha}`);
    let releaseBranchCreated = false;
    try {
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${releaseBranch}`,
        sha
      });
      core.info(`Created release branch: ${releaseBranch}`);
      releaseBranchCreated = true;
    } catch (error) {
      if (error.status === 422) {
        core.info(`Release branch already exists: ${releaseBranch}`);
      } else {
        throw error;
      }
    }
    const metadata = {
      branch,
      runNumber,
      sha,
      projects: projectMetadata,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const prBody = `## Release from \`${branch}\`

### Metadata

\`\`\`yaml
${generateYamlMetadata(metadata)}
\`\`\`

### Projects

${projectMetadata.map((p) => `- **${p.name}**: \`${p.version}\` \u2192 \`${p.resolvedVersion}\``).join("\n")}

---
*Generated by create-release-pr action*
`;
    const { data: existingPRs } = await octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      base: releaseBranch,
      state: "open"
    });
    const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${releaseBranch}...${branch}`
    });
    const hasDifferences = comparison.ahead_by > 0 || comparison.behind_by > 0;
    if (!hasDifferences) {
      core.info("No differences between branches");
      if (existingPRs.length > 0) {
        const pr = existingPRs[0];
        await octokit.rest.pulls.update({
          owner,
          repo,
          pull_number: pr.number,
          state: "closed"
        });
        core.info(`Closed PR #${pr.number} (no differences)`);
      }
      core.info("\u2705 No PR needed - branches are identical");
      core.setOutput("pr-number", "");
      core.setOutput("pr-url", "");
      core.setOutput("release-branch", releaseBranch);
      return;
    }
    let prNumber;
    let prUrl;
    if (existingPRs.length > 0) {
      const pr = existingPRs[0];
      const { data: updatedPR } = await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: pr.number,
        body: prBody
      });
      prNumber = updatedPR.number;
      prUrl = updatedPR.html_url;
      core.info(`Updated existing PR #${prNumber}`);
    } else {
      const { data: newPR } = await octokit.rest.pulls.create({
        owner,
        repo,
        title: `Release from ${branch}`,
        head: branch,
        base: releaseBranch,
        body: prBody,
        draft: true
      });
      prNumber = newPR.number;
      prUrl = newPR.html_url;
      core.info(`Created new PR #${prNumber}`);
    }
    core.setOutput("pr-number", prNumber);
    core.setOutput("pr-url", prUrl);
    core.setOutput("release-branch", releaseBranch);
    core.info(`\u2705 Success! PR: ${prUrl}`);
  } catch (error) {
    core.setFailed(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function generateYamlMetadata(metadata) {
  const yaml = [
    `sourceBranch: ${metadata.branch}`,
    `runNumber: ${metadata.runNumber}`,
    `sha: ${metadata.sha}`,
    `timestamp: ${metadata.generatedAt}`,
    "projects:"
  ];
  for (const project of metadata.projects) {
    yaml.push(`  - name: ${project.name}`);
    yaml.push(`    version: ${project.resolvedVersion}`);
    yaml.push(`    prerelease: ${project.isPreRelease}`);
    yaml.push(`    cwd: ${project.cwd}`);
  }
  return yaml.join("\n");
}
run();
//# sourceMappingURL=index.cjs.map