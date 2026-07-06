#!/usr/bin/env node
/**
 * gitflow pack-deploy
 *
 * Called by the project's github.actions.pack-deploy script after it has
 * written its deploy files to DEPLOY_OUTPUT_DIR.  This script:
 *   1. Reads the project-written deploy.yml from DEPLOY_OUTPUT_DIR
 *   2. Validates deployCommand is present
 *   3. Injects name / version / repo / releaseId into deploy.yml
 *   4. Zips DEPLOY_OUTPUT_DIR → ARTIFACT_OUTPUT_DIR/<name>-deploy.zip
 *
 * Required env vars:
 *   PROJECT_NAME        — package name (e.g. @org/my-app)
 *   PROJECT_VERSION     — semver string
 *   GITHUB_RELEASE_ID   — numeric GitHub Release ID
 *   GITHUB_REPOSITORY   — owner/repo
 *   DEPLOY_OUTPUT_DIR   — directory the project wrote its deploy files to
 *
 * Optional env vars:
 *   ARTIFACT_OUTPUT_DIR — defaults to <cwd>/.artifacts
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'zx';
import { parse, stringify } from 'yaml';

async function packDeploy(): Promise<void> {
  const projectName = process.env.PROJECT_NAME;
  const version = process.env.PROJECT_VERSION;
  const releaseIdStr = process.env.GITHUB_RELEASE_ID;
  const githubRepository = process.env.GITHUB_REPOSITORY ?? '';
  const cwd = process.cwd();
  const outputDir = process.env.ARTIFACT_OUTPUT_DIR ?? join(cwd, '.artifacts');
  const deployOutputDir = process.env.DEPLOY_OUTPUT_DIR;

  if (!projectName || !version) {
    throw new Error('PROJECT_NAME and PROJECT_VERSION environment variables are required');
  }
  if (!releaseIdStr) {
    throw new Error('GITHUB_RELEASE_ID environment variable is required');
  }
  if (!deployOutputDir) {
    throw new Error('DEPLOY_OUTPUT_DIR environment variable is required');
  }
  if (!existsSync(deployOutputDir)) {
    throw new Error(`DEPLOY_OUTPUT_DIR does not exist: ${deployOutputDir}`);
  }

  const releaseId = parseInt(releaseIdStr, 10);

  // Read and validate project-supplied deploy.yml
  const deployYmlPath = join(deployOutputDir, 'deploy.yml');
  if (!existsSync(deployYmlPath)) {
    throw new Error(`deploy.yml not found in DEPLOY_OUTPUT_DIR (${deployOutputDir}). The project's pack-deploy script must write it.`);
  }

  const existing = parse(await readFile(deployYmlPath, 'utf-8')) as Record<string, unknown>;
  if (!existing.deployCommand) {
    throw new Error(`deploy.yml is missing required field: deployCommand`);
  }

  // Inject git-flow-managed metadata (overwrites any project-supplied values for these fields)
  const deployYml = {
    ...existing,
    name: projectName,
    version,
    repo: `https://github.com/${githubRepository}`,
    releaseId,
  };
  await writeFile(deployYmlPath, stringify(deployYml));

  // Zip DEPLOY_OUTPUT_DIR into deploy.zip
  const artifactFilename = projectName.replace(/@/g, '').replace(/\//g, '-');
  const deployZipPath = join(outputDir, `${artifactFilename}-deploy.zip`);

  await mkdir(outputDir, { recursive: true });
  await $({ cwd: deployOutputDir })`zip -r ${deployZipPath} .`;

  console.log(`✓ ${projectName}: deploy.zip created → ${deployZipPath}`);
}

packDeploy().catch((error) => {
  console.error('pack-deploy failed:', error);
  process.exit(1);
});
