"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var pack_exports = {};
__export(pack_exports, {
  default: () => Pack
});
module.exports = __toCommonJS(pack_exports);
var import_core = require("@oclif/core");
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var import_zx = require("zx");
var import_yaml = require("yaml");
var import_config_loader = require("../config-loader.js");
async function detectProjectType(cwd) {
  if ((0, import_node_fs.existsSync)((0, import_node_path.join)(cwd, "package.json"))) {
    return "npm";
  }
  const { stdout } = await (0, import_zx.$)({ cwd })`find . -maxdepth 1 -name "*.csproj" -print -quit`;
  if (stdout.trim()) {
    return "nuget";
  }
  return "unknown";
}
async function packNpm(context) {
  const { cwd, outputDir, artifactFilename, version } = context;
  await (0, import_zx.$)({ cwd })`pnpm pack --pack-destination ${outputDir}`;
  const tarballName = `${artifactFilename}-${version}.tgz`;
  const { basename } = await import("node:path");
  const artifactRelativePath = `${basename(outputDir)}/${tarballName}`;
  const descriptor = {
    project: context.projectName,
    artifacts: [
      {
        type: "npm",
        name: context.projectName,
        path: artifactRelativePath,
        registries: ["github-npm"]
      }
    ]
  };
  const descriptorPath = (0, import_node_path.join)(outputDir, `${artifactFilename}.artifact.yml`);
  await (0, import_promises.writeFile)(descriptorPath, (0, import_yaml.stringify)(descriptor));
  console.log(`\u2713 Created NPM package: ${tarballName}`);
  console.log(`\u2713 Created artifact descriptor: ${descriptorPath}`);
}
async function packNuget(context) {
  const { cwd, outputDir, artifactFilename, version } = context;
  await (0, import_zx.$)({ cwd })`dotnet pack -c Release -o ${outputDir} /p:Version=${version}`;
  const nupkgName = `${artifactFilename}.${version}.nupkg`;
  const { relative } = await import("node:path");
  const relativePath = relative(cwd, (0, import_node_path.join)(outputDir, nupkgName));
  const descriptor = {
    project: context.projectName,
    artifacts: [
      {
        type: "nuget",
        name: context.projectName,
        path: relativePath,
        registries: ["ghcr"]
      }
    ]
  };
  const artifactPath = (0, import_node_path.join)(outputDir, `${artifactFilename}.artifact.yml`);
  await (0, import_promises.writeFile)(artifactPath, (0, import_yaml.stringify)(descriptor));
  console.log(`\u2713 Created NuGet package: ${nupkgName}`);
  console.log(`\u2713 Created artifact descriptor: ${artifactPath}`);
}
async function defaultPack(context) {
  const projectType = await detectProjectType(context.cwd);
  await (0, import_promises.mkdir)(context.outputDir, { recursive: true });
  switch (projectType) {
    case "npm":
      await packNpm(context);
      break;
    case "nuget":
      await packNuget(context);
      break;
    default:
      throw new Error(`Unable to detect project type in ${context.cwd}`);
  }
}
class Pack extends import_core.Command {
  static description = "Pack project artifacts (NPM/NuGet) with optional configuration hooks";
  static examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --output-dir ./dist",
    "PROJECT_NAME=my-package PROJECT_VERSION=1.0.0 <%= config.bin %> <%= command.id %>"
  ];
  static flags = {
    "output-dir": import_core.Flags.string({
      char: "o",
      description: "Output directory for artifacts (overrides ARTIFACT_OUTPUT_DIR)"
    }),
    "project-name": import_core.Flags.string({
      char: "n",
      description: "Project name (overrides PROJECT_NAME env var)"
    }),
    "version": import_core.Flags.string({
      char: "v",
      description: "Project version (overrides PROJECT_VERSION env var)"
    })
  };
  async run() {
    const { flags } = await this.parse(Pack);
    const projectName = flags["project-name"] || process.env.PROJECT_NAME;
    const version = flags.version || process.env.PROJECT_VERSION;
    const cwd = process.cwd();
    const outputDir = flags["output-dir"] || process.env.ARTIFACT_OUTPUT_DIR || (0, import_node_path.join)(cwd, ".artifacts");
    const artifactFilename = process.env.ARTIFACT_FILENAME || projectName?.replace(/@/g, "").replace(/\//g, "-") || "artifact";
    const sha = process.env.GITHUB_SHA || "local";
    if (!projectName || !version) {
      this.error("PROJECT_NAME and PROJECT_VERSION are required (via flags or environment variables)");
    }
    const context = {
      projectName,
      version,
      cwd,
      outputDir,
      artifactFilename,
      sha
    };
    const config = await (0, import_config_loader.loadConfig)(cwd);
    try {
      if (config?.pack?.execute) {
        await config.pack.execute(context);
      } else {
        if (config?.pack?.beforePack) {
          await config.pack.beforePack(context);
        }
        await defaultPack(context);
        if (config?.pack?.afterPack) {
          await config.pack.afterPack(context);
        }
      }
    } catch (error) {
      this.error(`Pack failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
//# sourceMappingURL=pack.js.map