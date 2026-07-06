/**
 * gitflow pack-deploy command
 *
 * Called by a project's github.actions.pack-deploy script after it has written
 * its deploy files (including a deploy.yml with deployCommand) to DEPLOY_OUTPUT_DIR.
 *
 * Validates the folder, injects git-flow-managed metadata into deploy.yml,
 * then zips everything into ARTIFACT_OUTPUT_DIR/<name>-deploy.zip.
 */

import { Command, Flags } from '@oclif/core';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'zx';
import { parse, stringify } from 'yaml';

export default class PackDeploy extends Command {
  static override description =
    'Validate a project-built deploy folder, inject release metadata into deploy.yml, and zip it';

  static override examples = [
    'PROJECT_NAME=my-app PROJECT_VERSION=1.0.0 GITHUB_RELEASE_ID=123 DEPLOY_OUTPUT_DIR=.deploy-output <%= config.bin %> <%= command.id %>',
  ];

  static override flags = {
    'output-dir': Flags.string({
      char: 'o',
      description: 'Artifact output directory (overrides ARTIFACT_OUTPUT_DIR)',
    }),
    'deploy-output-dir': Flags.string({
      char: 'd',
      description: 'Directory containing project deploy files (overrides DEPLOY_OUTPUT_DIR)',
    }),
    'project-name': Flags.string({
      char: 'n',
      description: 'Project name (overrides PROJECT_NAME env var)',
    }),
    version: Flags.string({
      char: 'v',
      description: 'Project version (overrides PROJECT_VERSION env var)',
    }),
    'release-id': Flags.integer({
      char: 'r',
      description: 'GitHub Release ID (overrides GITHUB_RELEASE_ID env var)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(PackDeploy);

    const projectName = flags['project-name'] ?? process.env.PROJECT_NAME;
    const version = flags['version'] ?? process.env.PROJECT_VERSION;
    const releaseIdRaw = flags['release-id'] ?? process.env.GITHUB_RELEASE_ID;
    const githubRepository = process.env.GITHUB_REPOSITORY ?? '';
    const cwd = process.cwd();
    const outputDir = flags['output-dir'] ?? process.env.ARTIFACT_OUTPUT_DIR ?? join(cwd, '.artifacts');
    const deployOutputDir = flags['deploy-output-dir'] ?? process.env.DEPLOY_OUTPUT_DIR;

    if (!projectName || !version) {
      this.error('PROJECT_NAME and PROJECT_VERSION are required');
    }
    if (!releaseIdRaw) {
      this.error('GITHUB_RELEASE_ID is required');
    }
    if (!deployOutputDir) {
      this.error('DEPLOY_OUTPUT_DIR is required');
    }
    if (!existsSync(deployOutputDir)) {
      this.error(`DEPLOY_OUTPUT_DIR does not exist: ${deployOutputDir}`);
    }

    const releaseId = typeof releaseIdRaw === 'number' ? releaseIdRaw : parseInt(String(releaseIdRaw), 10);

    // Read and validate project-supplied deploy.yml
    const deployYmlPath = join(deployOutputDir, 'deploy.yml');
    if (!existsSync(deployYmlPath)) {
      this.error(
        `deploy.yml not found in DEPLOY_OUTPUT_DIR (${deployOutputDir}). ` +
        `The project's pack-deploy script must write it.`,
      );
    }

    const existing = parse(await readFile(deployYmlPath, 'utf-8')) as Record<string, unknown>;
    if (!existing.deployCommand) {
      this.error('deploy.yml is missing required field: deployCommand');
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

    this.log(`✓ ${projectName}: deploy.zip created → ${deployZipPath}`);
  }
}
