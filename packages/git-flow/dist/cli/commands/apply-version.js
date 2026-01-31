import { Command, Args, Flags } from '@oclif/core';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { $ } from 'zx';
import { pathToFileURL } from 'url';

// src/cli/commands/apply-version.ts
async function loadConfig(cwd) {
  const configPaths = [
    join(cwd, "cpdevtools.config.ts"),
    join(cwd, "cpdevtools.config.js"),
    join(cwd, "cpdevtools.config.mjs")
  ];
  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const configUrl = pathToFileURL(configPath).href;
        const module = await import(configUrl);
        const config = module.default || module;
        return config;
      } catch (error) {
        console.warn(`Warning: Failed to load config from ${configPath}:`, error);
      }
    }
  }
  return void 0;
}

// src/cli/commands/apply-version.ts
async function applyVersionToPackageJson(cwd, version) {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) {
    return;
  }
  const content = await readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(content);
  pkg.version = version;
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`\u2713 Updated package.json to version ${version}`);
}
async function applyVersionToCsproj(cwd, version) {
  const { stdout } = await $({ cwd })`find . -maxdepth 1 -name "*.csproj"`;
  const csprojFiles = stdout.trim().split("\n").filter(Boolean);
  for (const csprojFile of csprojFiles) {
    const csprojPath = join(cwd, csprojFile);
    let content = await readFile(csprojPath, "utf-8");
    if (content.includes("<Version>")) {
      content = content.replace(/<Version>.*?<\/Version>/, `<Version>${version}</Version>`);
    } else {
      content = content.replace(
        /<PropertyGroup>/,
        `<PropertyGroup>
    <Version>${version}</Version>`
      );
    }
    await writeFile(csprojPath, content);
    console.log(`\u2713 Updated ${csprojFile} to version ${version}`);
  }
}
async function defaultApplyVersion(context) {
  const { cwd, version } = context;
  await applyVersionToPackageJson(cwd, version);
  await applyVersionToCsproj(cwd, version);
}
var ApplyVersion = class _ApplyVersion extends Command {
  static description = "Apply version to project files (package.json, .csproj) with optional configuration hooks";
  static examples = [
    "<%= config.bin %> <%= command.id %> 1.2.3",
    "<%= config.bin %> <%= command.id %> --version 1.2.3",
    "PROJECT_VERSION=1.2.3 <%= config.bin %> <%= command.id %>"
  ];
  static args = {
    version: Args.string({
      description: "Version to apply to project files",
      required: false
    })
  };
  static flags = {
    version: Flags.string({
      char: "v",
      description: "Version to apply (overrides PROJECT_VERSION env var)"
    }),
    "project-name": Flags.string({
      char: "n",
      description: "Project name (overrides PROJECT_NAME env var)"
    })
  };
  async run() {
    const { args, flags } = await this.parse(_ApplyVersion);
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
    const config = await loadConfig(cwd);
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
};

export { ApplyVersion as default };
//# sourceMappingURL=apply-version.js.map
//# sourceMappingURL=apply-version.js.map