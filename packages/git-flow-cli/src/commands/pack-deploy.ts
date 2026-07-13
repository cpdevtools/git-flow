/**
 * gitflow pack-deploy <method>
 *
 * Convention-driven deploy bundle builder.  Called by a project's
 * github.actions.pack-deploy-{method} script to copy the standard source files
 * for the given deploy method into DEPLOY_OUTPUT_DIR and write a deploy.yml
 * with the conventional deployCommand.
 *
 * Supported methods:
 *   compose — copies docker-compose.yml (+ docker-compose.*.yml overrides)
 *               deployCommand: docker compose pull && docker compose up -d
 *   swarm   — copies stack.yml + stack.*.yml overlays
 *               deployCommand: docker stack deploy -c stack.yml <stack-name>
 *   node    — copies ecosystem.config.js
 *               deployCommand: pm2 reload ecosystem.config.js
 *
 * Required env vars:
 *   DEPLOY_OUTPUT_DIR  — destination directory (the orchestrator sets this per method)
 *   PROJECT_NAME       — package name (used for swarm stack name derivation)
 */

import { Args, Command, Flags } from '@oclif/core';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { safeName } from '@cpdevtools/git-flow/artifacts';

export default class PackDeploy extends Command {
  static override description =
    'Convention-driven deploy bundle builder: copies method-specific files and writes deploy.yml';

  static override args = {
    method: Args.string({
      description: 'Deploy method: compose, swarm, or node',
      required: true,
    }),
  };

  static override examples = [
    'DEPLOY_OUTPUT_DIR=.deploy-output/compose <%= config.bin %> <%= command.id %> compose',
    'DEPLOY_OUTPUT_DIR=.deploy-output/swarm <%= config.bin %> <%= command.id %> swarm',
    'DEPLOY_OUTPUT_DIR=.deploy-output/node <%= config.bin %> <%= command.id %> node',
  ];

  static override flags = {
    'deploy-output-dir': Flags.string({
      char: 'd',
      description: 'Destination directory (overrides DEPLOY_OUTPUT_DIR)',
    }),
    'project-name': Flags.string({
      char: 'n',
      description: 'Project name (overrides PROJECT_NAME env var)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PackDeploy);
    const method = args.method;

    const projectName = flags['project-name'] ?? process.env.PROJECT_NAME ?? '';
    const cwd = process.cwd();
    const deployOutputDir = flags['deploy-output-dir'] ?? process.env.DEPLOY_OUTPUT_DIR;

    if (!deployOutputDir) {
      this.error('DEPLOY_OUTPUT_DIR is required (via --deploy-output-dir or env var)');
    }

    await mkdir(deployOutputDir, { recursive: true });

    switch (method) {
      case 'compose':
        await this.handleCompose(cwd, deployOutputDir);
        break;
      case 'swarm':
        await this.handleSwarm(cwd, deployOutputDir, projectName);
        break;
      case 'node':
        await this.handleNode(cwd, deployOutputDir);
        break;
      default:
        this.error(
          `Unknown deploy method: "${method}". Supported methods: compose, swarm, node`,
        );
    }

    this.log(`\u2713 pack-deploy-${method} complete`);
  }

  private async handleCompose(cwd: string, destDir: string): Promise<void> {
    const composeFile = join(cwd, 'docker-compose.yml');
    if (!existsSync(composeFile)) {
      this.error('docker-compose.yml not found in project root');
    }
    await copyFile(composeFile, join(destDir, 'docker-compose.yml'));

    // Copy any docker-compose.*.yml override files
    const all = await readdir(cwd);
    for (const file of all) {
      if (
        file.startsWith('docker-compose.') &&
        file.endsWith('.yml') &&
        file !== 'docker-compose.yml'
      ) {
        await copyFile(join(cwd, file), join(destDir, file));
      }
    }

    await writeFile(
      join(destDir, 'deploy.yml'),
      stringify({ deployCommand: 'docker compose pull && docker compose up -d' }),
    );
  }

  private async handleSwarm(cwd: string, destDir: string, projectName: string): Promise<void> {
    const stackFile = join(cwd, 'stack.yml');
    if (!existsSync(stackFile)) {
      this.error('stack.yml not found in project root');
    }
    await copyFile(stackFile, join(destDir, 'stack.yml'));

    // Copy stack.*.yml overlays
    const all = await readdir(cwd);
    for (const file of all) {
      if (file.startsWith('stack.') && file.endsWith('.yml') && file !== 'stack.yml') {
        await copyFile(join(cwd, file), join(destDir, file));
      }
    }

    const stackName = safeName(projectName).replace(/-/g, '_');
    await writeFile(
      join(destDir, 'deploy.yml'),
      stringify({ deployCommand: `docker stack deploy -c stack.yml ${stackName}` }),
    );
  }

  private async handleNode(cwd: string, destDir: string): Promise<void> {
    const ecoFile = join(cwd, 'ecosystem.config.js');
    if (!existsSync(ecoFile)) {
      this.error('ecosystem.config.js not found in project root');
    }
    await copyFile(ecoFile, join(destDir, 'ecosystem.config.js'));

    await writeFile(
      join(destDir, 'deploy.yml'),
      stringify({ deployCommand: 'pm2 reload ecosystem.config.js' }),
    );
  }
}

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
