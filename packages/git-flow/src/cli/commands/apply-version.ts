/**
 * gitflow apply-version command
 * Applies version to project files with hook support
 */

import { Command, Flags, Args } from '@oclif/core';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'zx';
import { loadConfig } from '../config-loader.js';
import type { ApplyVersionContext } from '../types.js';

/**
 * Apply version to package.json
 */
async function applyVersionToPackageJson(cwd: string, version: string): Promise<void> {
  const pkgPath = join(cwd, 'package.json');
  
  if (!existsSync(pkgPath)) {
    return;
  }
  
  const content = await readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(content);
  
  pkg.version = version;
  
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`✓ Updated package.json to version ${version}`);
}

/**
 * Apply version to .csproj files
 */
async function applyVersionToCsproj(cwd: string, version: string): Promise<void> {
  // Find all .csproj files
  const { stdout } = await $({ cwd })`find . -maxdepth 1 -name "*.csproj"`;
  const csprojFiles = stdout.trim().split('\n').filter(Boolean);
  
  for (const csprojFile of csprojFiles) {
    const csprojPath = join(cwd, csprojFile);
    let content = await readFile(csprojPath, 'utf-8');
    
    // Update <Version> tag
    if (content.includes('<Version>')) {
      content = content.replace(/<Version>.*?<\/Version>/, `<Version>${version}</Version>`);
    } else {
      // Add Version tag if not present
      content = content.replace(
        /<PropertyGroup>/,
        `<PropertyGroup>\n    <Version>${version}</Version>`
      );
    }
    
    await writeFile(csprojPath, content);
    console.log(`✓ Updated ${csprojFile} to version ${version}`);
  }
}

/**
 * Default version application implementation
 */
async function defaultApplyVersion(context: ApplyVersionContext): Promise<void> {
  const { cwd, version } = context;
  
  // Apply to package.json (NPM projects)
  await applyVersionToPackageJson(cwd, version);
  
  // Apply to .csproj (NuGet projects)
  await applyVersionToCsproj(cwd, version);
}

export default class ApplyVersion extends Command {
  static override description = 'Apply version to project files (package.json, .csproj) with optional configuration hooks';

  static override examples = [
    '<%= config.bin %> <%= command.id %> 1.2.3',
    '<%= config.bin %> <%= command.id %> --version 1.2.3',
    'PROJECT_VERSION=1.2.3 <%= config.bin %> <%= command.id %>',
  ];

  static override args = {
    version: Args.string({
      description: 'Version to apply to project files',
      required: false,
    }),
  };

  static override flags = {
    version: Flags.string({
      char: 'v',
      description: 'Version to apply (overrides PROJECT_VERSION env var)',
    }),
    'project-name': Flags.string({
      char: 'n',
      description: 'Project name (overrides PROJECT_NAME env var)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ApplyVersion);
    
    // Read version from flags, args, or environment (in that order)
    const version = flags.version || args.version || process.env.PROJECT_VERSION;
    const projectName = flags['project-name'] || process.env.PROJECT_NAME || 'unknown';
    const cwd = process.cwd();
    
    if (!version) {
      this.error('Version is required (via argument, --version flag, or PROJECT_VERSION env var)');
    }
    
    const context: ApplyVersionContext = {
      projectName,
      version,
      cwd,
    };
    
    // Load config
    const config = await loadConfig(cwd);
    
    try {
      // Execute with hooks
      if (config?.applyVersion?.execute) {
        // Complete override
        await config.applyVersion.execute(context);
      } else {
        // Run with before/after hooks
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
