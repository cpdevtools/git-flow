"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var apply_version_exports = {};
__export(apply_version_exports, {
  default: () => ApplyVersion
});
module.exports = __toCommonJS(apply_version_exports);
var import_core = require("@oclif/core");
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var import_zx = require("zx");
var import_config_loader = require("../config-loader.js");
async function applyVersionToPackageJson(cwd, version) {
  const pkgPath = (0, import_node_path.join)(cwd, "package.json");
  if (!(0, import_node_fs.existsSync)(pkgPath)) {
    return;
  }
  const content = await (0, import_promises.readFile)(pkgPath, "utf-8");
  const pkg = JSON.parse(content);
  pkg.version = version;
  await (0, import_promises.writeFile)(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`\u2713 Updated package.json to version ${version}`);
}
async function applyVersionToCsproj(cwd, version) {
  const { stdout } = await (0, import_zx.$)({ cwd })`find . -maxdepth 1 -name "*.csproj"`;
  const csprojFiles = stdout.trim().split("\n").filter(Boolean);
  for (const csprojFile of csprojFiles) {
    const csprojPath = (0, import_node_path.join)(cwd, csprojFile);
    let content = await (0, import_promises.readFile)(csprojPath, "utf-8");
    if (content.includes("<Version>")) {
      content = content.replace(/<Version>.*?<\/Version>/, `<Version>${version}</Version>`);
    } else {
      content = content.replace(
        /<PropertyGroup>/,
        `<PropertyGroup>
    <Version>${version}</Version>`
      );
    }
    await (0, import_promises.writeFile)(csprojPath, content);
    console.log(`\u2713 Updated ${csprojFile} to version ${version}`);
  }
}
async function defaultApplyVersion(context) {
  const { cwd, version } = context;
  await applyVersionToPackageJson(cwd, version);
  await applyVersionToCsproj(cwd, version);
}
class ApplyVersion extends import_core.Command {
  static description = "Apply version to project files (package.json, .csproj) with optional configuration hooks";
  static examples = [
    "<%= config.bin %> <%= command.id %> 1.2.3",
    "<%= config.bin %> <%= command.id %> --version 1.2.3",
    "PROJECT_VERSION=1.2.3 <%= config.bin %> <%= command.id %>"
  ];
  static args = {
    version: import_core.Args.string({
      description: "Version to apply to project files",
      required: false
    })
  };
  static flags = {
    version: import_core.Flags.string({
      char: "v",
      description: "Version to apply (overrides PROJECT_VERSION env var)"
    }),
    "project-name": import_core.Flags.string({
      char: "n",
      description: "Project name (overrides PROJECT_NAME env var)"
    })
  };
  async run() {
    const { args, flags } = await this.parse(ApplyVersion);
    const version = flags.version || args.version || process.env.PROJECT_VERSION;
    const projectName = flags["project-name"] || process.env.PROJECT_NAME || "unknown";
    const cwd = process.cwd();
    if (!version) {
      this.error("Version is required (via argument, --version flag, or PROJECT_VERSION env var)");
    }
    const context = {
      projectName,
      version,
      cwd
    };
    const config = await (0, import_config_loader.loadConfig)(cwd);
    try {
      if (config?.applyVersion?.execute) {
        await config.applyVersion.execute(context);
      } else {
        if (config?.applyVersion?.beforeApplyVersion) {
          await config.applyVersion.beforeApplyVersion(context);
        }
        await defaultApplyVersion(context);
        if (config?.applyVersion?.afterApplyVersion) {
          await config.applyVersion.afterApplyVersion(context);
        }
      }
    } catch (error) {
      this.error(`Apply version failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
//# sourceMappingURL=apply-version.js.map