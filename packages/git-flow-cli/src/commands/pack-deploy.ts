/**
 * gitflow pack-deploy <method>
 *
 * Convention-driven deploy bundle builder.  Called by a project's
 * github.actions.pack-deploy-{method} script to copy the standard source files
 * for the given deploy method into DEPLOY_OUTPUT_DIR and write a deploy.yml
 * with the conventional deployCommand.
 *
 * Method resolution delegates to the registered DeployMethodHandler for the
 * artifact type.  Built-in handlers:
 *   docker.compose — copies docker-compose.yml + overrides; deploy.yml = docker compose pull && up -d
 *   docker.swarm   — copies stack.yml + overlays; deploy.yml = docker stack deploy --with-registry-auth -c stack.yml ...
 *   npm.node       — copies ecosystem.config.js; deploy.yml = pm2 reload ecosystem.config.js
 *
 * Plugins can register additional handlers via registerDeployMethod().
 *
 * Required env vars:
 *   DEPLOY_OUTPUT_DIR  — destination directory (the orchestrator sets this per method)
 *   ARTIFACT_TYPE      — artifact type (the orchestrator sets this; defaults to 'docker')
 *   PROJECT_NAME       — package name (used for swarm stack name derivation)
 */

import { Args, Command, Flags } from '@oclif/core';
import { mkdir } from 'node:fs/promises';
import {
  findWorkspaceRoot,
  getDeployMethod,
  listDeployMethods,
  loadPlugins,
  type DeployMethodContext,
} from '@cpdevtools/git-flow/artifacts';

export default class PackDeploy extends Command {
  static override description =
    'Convention-driven deploy bundle builder: delegates to the registered DeployMethodHandler for the artifact type';

  static override args = {
    method: Args.string({
      description: 'Deploy method name (e.g. compose, swarm, node, or a plugin-registered method)',
      required: true,
    }),
  };

  static override examples = [
    'DEPLOY_OUTPUT_DIR=.deploy-output/compose ARTIFACT_TYPE=docker <%= config.bin %> <%= command.id %> compose',
    'DEPLOY_OUTPUT_DIR=.deploy-output/swarm  ARTIFACT_TYPE=docker <%= config.bin %> <%= command.id %> swarm',
    'DEPLOY_OUTPUT_DIR=.deploy-output/node   ARTIFACT_TYPE=npm   <%= config.bin %> <%= command.id %> node',
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
    'artifact-type': Flags.string({
      char: 't',
      description:
        "Artifact type to look up handler for (overrides ARTIFACT_TYPE; defaults to 'docker')",
    }),
    version: Flags.string({
      char: 'v',
      description: 'Package version (overrides PROJECT_VERSION env var)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PackDeploy);
    const method = args.method;

    const projectName = flags['project-name'] ?? process.env.PROJECT_NAME ?? '';
    const version = flags['version'] ?? process.env.PROJECT_VERSION ?? '';
    const deployOutputDir = flags['deploy-output-dir'] ?? process.env.DEPLOY_OUTPUT_DIR;
    const artifactTypeFlag = flags['artifact-type'] ?? process.env.ARTIFACT_TYPE;

    if (!deployOutputDir) {
      this.error('DEPLOY_OUTPUT_DIR is required (via --deploy-output-dir or env var)');
    }

    // Orchestrator sets ARTIFACT_TYPE before running project scripts; default to 'docker'
    const artifactType = artifactTypeFlag ?? 'docker';
    if (!artifactTypeFlag) {
      this.warn(
        `ARTIFACT_TYPE not set; defaulting to 'docker'. Use --artifact-type or set ARTIFACT_TYPE to be explicit.`,
      );
    }

    await mkdir(deployOutputDir, { recursive: true });

    // This command never registered plugins, so a plugin-supplied deploy method
    // was unreachable here even though the orchestrator could find it.
    const projectCwd = process.cwd();
    const workspaceRoot = await findWorkspaceRoot(projectCwd);
    await loadPlugins({ workspaceRoot, projectCwd });

    const ctx: DeployMethodContext = {
      projectCwd,
      workspaceRoot,
      deployOutputDir,
      projectName,
      version,
      method,
    };

    const handler = getDeployMethod(artifactType, method);
    if (!handler) {
      const known = listDeployMethods(artifactType);
      this.error(
        `No deploy method handler registered for ${artifactType}.${method}.\n` +
          `Registered methods for '${artifactType}': ${known.join(', ') || '(none)'}.\n` +
          `Register one with: registerDeployMethod('${artifactType}', '${method}', { copyFiles, generateDeployYml })`,
      );
    }

    await handler.copyFiles(ctx);
    await handler.generateDeployYml(ctx);

    this.log(`\u2713 pack-deploy-${method} complete`);
  }
}
