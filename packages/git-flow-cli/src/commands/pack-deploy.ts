/**
 * gitflow pack-deploy command
 *
 * Called by a project's github.actions.pack-deploy script after it has written
 * its deploy files (including deploy.yml with deployCommand) to DEPLOY_OUTPUT_DIR.
 *
 * Reads release-artifacts.yml to find deploy artifact entries, dispatches each
 * to the deploy type handler's packDeploy() method, then updates the existing
 * .artifact.yml descriptor with the produced zip path(s).
 *
 * Required env vars:
 *   PROJECT_NAME        — package name
 *   PROJECT_VERSION     — semver string
 *   GITHUB_RELEASE_ID   — numeric release ID
 *   GITHUB_REPOSITORY   — owner/repo
 *   DEPLOY_OUTPUT_DIR   — directory the project wrote deploy files to
 *   ARTIFACT_OUTPUT_DIR — output directory (defaults to /tmp/git-flow-artifacts)
 */

import { Command, Flags } from '@oclif/core';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  getArtifactType,
  safeName,
  writeArtifact,
  type PackDeployContext,
  type DeployArtifact,
  type ProjectArtifactDescriptor,
} from '@cpdevtools/git-flow/artifacts';
import { loadArtifactConfig, ARTIFACT_OUTPUT_DIR } from '@cpdevtools/git-flow/build-pack';

export default class PackDeploy extends Command {
  static override description =
    'Validate a project-built deploy folder, inject release metadata, zip it, and update the artifact descriptor';

  static override examples = [
    'PROJECT_NAME=@org/svc PROJECT_VERSION=1.0.0 GITHUB_RELEASE_ID=123 DEPLOY_OUTPUT_DIR=.deploy-output/<%= config.bin %> <%= command.id %>',
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
    const version = flags.version ?? process.env.PROJECT_VERSION;
    const releaseIdRaw = flags['release-id'] ?? process.env.GITHUB_RELEASE_ID;
    const githubRepository = process.env.GITHUB_REPOSITORY ?? '';
    const cwd = process.cwd();
    const outputDir = flags['output-dir'] ?? process.env.ARTIFACT_OUTPUT_DIR ?? ARTIFACT_OUTPUT_DIR;
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

    const releaseId =
      typeof releaseIdRaw === 'number' ? releaseIdRaw : parseInt(String(releaseIdRaw), 10);
    const artifactFilename = safeName(projectName);

    // Load release-artifacts config to find deploy artifact entries
    const envVars: Record<string, string> = {
      PROJECT_NAME: artifactFilename,
      ARTIFACT_OUTPUT_DIR: outputDir,
      PACKAGE_NAME: projectName,
      PACKAGE_VERSION: version,
    };
    const config = await loadArtifactConfig(cwd, envVars);
    if (!config) {
      this.error(`No release-artifacts configuration found in ${cwd}`);
    }

    const deployArtifacts = (config.artifacts ?? []).filter(
      (a): a is DeployArtifact => a.type === 'deploy',
    );
    if (deployArtifacts.length === 0) {
      this.error('No deploy artifacts declared in release-artifacts.yml');
    }

    const ctx: PackDeployContext = {
      projectCwd: cwd,
      artifactOutputDir: outputDir,
      deployOutputDir,
      projectName,
      version,
      releaseId,
      githubRepository,
    };

    for (const artifact of deployArtifacts) {
      await getArtifactType('deploy').packDeploy(artifact, ctx);
    }

    // Update the existing .artifact.yml descriptor with the produced zip path(s)
    const descriptorPath = join(outputDir, `${artifactFilename}.artifact.yml`);
    process.env.ARTIFACT_OUTPUT_DIR = outputDir;
    process.env.PROJECT_NAME = artifactFilename;

    if (existsSync(descriptorPath)) {
      const existing = parseYaml(
        await readFile(descriptorPath, 'utf-8'),
      ) as ProjectArtifactDescriptor;
      for (const deployArtifact of deployArtifacts) {
        const match = existing.artifacts.find(
          (a) => a.type === 'deploy' && a.name === deployArtifact.name,
        ) as DeployArtifact | undefined;
        if (match) {
          match.path = deployArtifact.path;
        } else {
          existing.artifacts.push(deployArtifact);
        }
      }
      await writeArtifact(existing);
    } else {
      // No prior descriptor — write one containing only the deploy artifacts
      await writeArtifact({ project: projectName, artifacts: deployArtifacts });
    }

    this.log(`\u2713 ${projectName}: pack-deploy complete`);
  }
}
