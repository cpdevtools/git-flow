/**
 * gitflow pack command
 * Default pack implementation with hook support
 */

import { Command, Flags } from '@oclif/core';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'zx';
import { stringify } from 'yaml';
import { loadConfig } from '../config-loader.js';
import type { PackContext, ArtifactDescriptor } from '../types.js';

/**
 * Detect project type based on files in directory
 */
async function detectProjectType(cwd: string): Promise<'npm' | 'nuget' | 'unknown'> {
  if (existsSync(join(cwd, 'package.json'))) {
    return 'npm';
  }
  
  // Check for .csproj files
  const { stdout } = await $({ cwd })`find . -maxdepth 1 -name "*.csproj" -print -quit`;
  if (stdout.trim()) {
    return 'nuget';
  }
  
  return 'unknown';
}

/**
 * Default pack implementation for NPM projects
 */
async function packNpm(context: PackContext): Promise<void> {
  const { cwd, outputDir, artifactFilename, version } = context;
  
  // Run npm pack
  await $({ cwd })`pnpm pack --pack-destination ${outputDir}`;
  
  // Find the generated tarball (npm creates filename from package name)
  const tarballName = `${artifactFilename}-${version}.tgz`;
  
  // Use just the output directory basename and tarball name
  // The upload step will resolve this relative to workspace root
  const { basename } = await import('node:path');
  const artifactRelativePath = `${basename(outputDir)}/${tarballName}`;
  
  // Create artifact descriptor with absolute path to avoid resolution issues
  const descriptor: ArtifactDescriptor = {
    project: context.projectName,
    artifacts: [
      {
        type: 'npm',
        name: context.projectName,
        path: artifactRelativePath,
        registries: ['github-npm'],
      },
    ],
  };
  
  const descriptorPath = join(outputDir, `${artifactFilename}.artifact.yml`);
  await writeFile(descriptorPath, stringify(descriptor));
  
  console.log(`✓ Created NPM package: ${tarballName}`);
  console.log(`✓ Created artifact descriptor: ${descriptorPath}`);
}

/**
 * Default pack implementation for NuGet projects
 */
async function packNuget(context: PackContext): Promise<void> {
  const { cwd, outputDir, artifactFilename, version } = context;
  
  // Run dotnet pack
  await $({ cwd })`dotnet pack -c Release -o ${outputDir} /p:Version=${version}`;
  
  // NuGet package filename
  const nupkgName = `${artifactFilename}.${version}.nupkg`;
  
  // Compute path relative to project cwd
  const { relative } = await import('node:path');
  const relativePath = relative(cwd, join(outputDir, nupkgName));
  
  // Create artifact descriptor
  const descriptor: ArtifactDescriptor = {
    project: context.projectName,
    artifacts: [
      {
        type: 'nuget',
        name: context.projectName,
        path: relativePath,
        registries: ['ghcr'],
      },
    ],
  };
  
  const artifactPath = join(outputDir, `${artifactFilename}.artifact.yml`);
  await writeFile(artifactPath, stringify(descriptor));
  
  console.log(`✓ Created NuGet package: ${nupkgName}`);
  console.log(`✓ Created artifact descriptor: ${artifactPath}`);
}

/**
 * Default pack implementation
 */
async function defaultPack(context: PackContext): Promise<void> {
  const projectType = await detectProjectType(context.cwd);
  
  // Ensure output directory exists
  await mkdir(context.outputDir, { recursive: true });
  
  switch (projectType) {
    case 'npm':
      await packNpm(context);
      break;
    case 'nuget':
      await packNuget(context);
      break;
    default:
      throw new Error(`Unable to detect project type in ${context.cwd}`);
  }
}

export default class Pack extends Command {
  static override description = 'Pack project artifacts (NPM/NuGet) with optional configuration hooks';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --output-dir ./dist',
    'PROJECT_NAME=my-package PROJECT_VERSION=1.0.0 <%= config.bin %> <%= command.id %>',
  ];

  static override flags = {
    'output-dir': Flags.string({
      char: 'o',
      description: 'Output directory for artifacts (overrides ARTIFACT_OUTPUT_DIR)',
    }),
    'project-name': Flags.string({
      char: 'n',
      description: 'Project name (overrides PROJECT_NAME env var)',
    }),
    'version': Flags.string({
      char: 'v',
      description: 'Project version (overrides PROJECT_VERSION env var)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Pack);
    
    // Read environment variables with flag overrides
    const projectName = flags['project-name'] || process.env.PROJECT_NAME;
    const version = flags.version || process.env.PROJECT_VERSION;
    const cwd = process.cwd();
    const outputDir = flags['output-dir'] || process.env.ARTIFACT_OUTPUT_DIR || join(cwd, '.artifacts');
    const artifactFilename = process.env.ARTIFACT_FILENAME || projectName?.replace(/@/g, '').replace(/\//g, '-') || 'artifact';
    const sha = process.env.GITHUB_SHA || 'local';
    
    if (!projectName || !version) {
      this.error('PROJECT_NAME and PROJECT_VERSION are required (via flags or environment variables)');
    }
    
    const context: PackContext = {
      projectName,
      version,
      cwd,
      outputDir,
      artifactFilename,
      sha,
    };
    
    // Load config
    const config = await loadConfig(cwd);
    
    try {
      // Execute pack with hooks
      if (config?.pack?.execute) {
        // Complete override
        await config.pack.execute(context);
      } else {
        // Run with before/after hooks
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
