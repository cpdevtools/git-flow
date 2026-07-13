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
