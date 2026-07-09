#!/usr/bin/env node
/**
 * cpdevtools-apply-version CLI
 * Applies version to project files with hook support
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'zx';
import { loadConfig } from './config-loader.js';
import type { ApplyVersionContext } from './types.js';

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
        `<PropertyGroup>\n    <Version>${version}</Version>`,
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

/**
 * Main apply-version function with hooks
 */
async function applyVersion(): Promise<void> {
  // Read environment variables or command line args
  const version = process.env.PROJECT_VERSION || process.argv[2];
  const projectName = process.env.PROJECT_NAME || 'unknown';
  const cwd = process.cwd();

  if (!version) {
    throw new Error('Version is required (set PROJECT_VERSION or pass as argument)');
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
    console.error('Apply version failed:', error);
    process.exit(1);
  }
}

applyVersion();
