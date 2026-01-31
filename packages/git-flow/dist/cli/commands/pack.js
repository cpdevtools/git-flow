import { Command, Flags } from '@oclif/core';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { $ } from 'zx';
import { stringify } from 'yaml';
import { pathToFileURL } from 'url';

// src/cli/commands/pack.ts
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

// src/cli/commands/pack.ts
async function detectProjectType(cwd) {
  if (existsSync(join(cwd, "package.json"))) {
    return "npm";
  }
  const { stdout } = await $({ cwd })`find . -maxdepth 1 -name "*.csproj" -print -quit`;
  if (stdout.trim()) {
    return "nuget";
  }
  return "unknown";
}
async function packNpm(context) {
  const { cwd, outputDir, artifactFilename, version } = context;
  await $({ cwd })`pnpm pack --pack-destination ${outputDir}`;
  const tarballName = `${artifactFilename}-${version}.tgz`;
  const { relative } = await import('path');
  const relativePath = relative(cwd, join(outputDir, tarballName));
  const descriptor = {
    project: context.projectName,
    artifacts: [
      {
        type: "npm",
        name: context.projectName,
        path: relativePath,
        registries: ["npm", "github"]
      }
    ]
  };
  const artifactPath = join(outputDir, `${artifactFilename}.artifact.yml`);
  await writeFile(artifactPath, stringify(descriptor));
  console.log(`\u2713 Created NPM package: ${tarballName}`);
  console.log(`\u2713 Created artifact descriptor: ${artifactPath}`);
}
async function packNuget(context) {
  const { cwd, outputDir, artifactFilename, version } = context;
  await $({ cwd })`dotnet pack -c Release -o ${outputDir} /p:Version=${version}`;
  const nupkgName = `${artifactFilename}.${version}.nupkg`;
  const { relative } = await import('path');
  const relativePath = relative(cwd, join(outputDir, nupkgName));
  const descriptor = {
    project: context.projectName,
    artifacts: [
      {
        type: "nuget",
        name: context.projectName,
        path: relativePath,
        registries: ["nuget", "github"]
      }
    ]
  };
  const artifactPath = join(outputDir, `${artifactFilename}.artifact.yml`);
  await writeFile(artifactPath, stringify(descriptor));
  console.log(`\u2713 Created NuGet package: ${nupkgName}`);
  console.log(`\u2713 Created artifact descriptor: ${artifactPath}`);
}
async function defaultPack(context) {
  const projectType = await detectProjectType(context.cwd);
  await mkdir(context.outputDir, { recursive: true });
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
var Pack = class _Pack extends Command {
  static description = "Pack project artifacts (NPM/NuGet) with optional configuration hooks";
  static examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --output-dir ./dist",
    "PROJECT_NAME=my-package PROJECT_VERSION=1.0.0 <%= config.bin %> <%= command.id %>"
  ];
  static flags = {
    "output-dir": Flags.string({
      char: "o",
      description: "Output directory for artifacts (overrides ARTIFACT_OUTPUT_DIR)"
    }),
    "project-name": Flags.string({
      char: "n",
      description: "Project name (overrides PROJECT_NAME env var)"
    }),
    "version": Flags.string({
      char: "v",
      description: "Project version (overrides PROJECT_VERSION env var)"
    })
  };
  async run() {
    const { flags } = await this.parse(_Pack);
    const projectName = flags["project-name"] || process.env.PROJECT_NAME;
    const version = flags.version || process.env.PROJECT_VERSION;
    const cwd = process.cwd();
    const outputDir = flags["output-dir"] || process.env.ARTIFACT_OUTPUT_DIR || join(cwd, ".artifacts");
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
    const config = await loadConfig(cwd);
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
};

export { Pack as default };
//# sourceMappingURL=pack.js.map
//# sourceMappingURL=pack.js.map