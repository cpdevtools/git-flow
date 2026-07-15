/**
 * Deploy method handler registry
 *
 * Mirrors the artifact-type registry but maps (artifactType × method) pairs to
 * a two-phase handler:
 *
 *   copyFiles        — copies source files (docker-compose.yml, stack.yml, …)
 *                      into deployOutputDir
 *   generateDeployYml — writes deploy.yml with at least a deployCommand field
 *
 * The two-method split is required for the folder fall-through path:
 * when a project places custom source files in .deploy/{method}/ but omits
 * deploy.yml, the orchestrator copies the folder then calls generateDeployYml
 * to supplement the missing manifest.
 *
 * Usage (from a plugin):
 *   import { registerDeployMethod } from '@cpdevtools/git-flow/artifacts';
 *   registerDeployMethod('docker', 'k8s', { copyFiles, generateDeployYml });
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeployMethodContext {
  /** Absolute path to the project root */
  projectCwd: string;
  /** Absolute path to the deploy output directory for this method */
  deployOutputDir: string;
  /** Package name (e.g. '@org/my-app') */
  projectName: string;
  /** Package version (e.g. '1.2.3') */
  version: string;
  /** Deploy method name (e.g. 'compose', 'swarm', 'node') */
  method: string;
}

export interface DeployMethodHandler {
  /**
   * Copy source files from projectCwd into deployOutputDir.
   *
   * Skipped when the .deploy/{method}/ folder override is in use (the
   * orchestrator copies the folder's files instead). Only generateDeployYml
   * is called in that fall-through scenario.
   */
  copyFiles(ctx: DeployMethodContext): Promise<void>;

  /**
   * Write deploy.yml (with at minimum deployCommand) into deployOutputDir.
   *
   * Called after copyFiles on the full path, or alone when the folder
   * override provided source files but no deploy.yml.
   */
  generateDeployYml(ctx: DeployMethodContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// Map<artifactType, Map<method, DeployMethodHandler>>
const deployMethodRegistry = new Map<string, Map<string, DeployMethodHandler>>();

/**
 * Register (or override) a deploy method handler for a given artifact type.
 *
 * Built-in handlers are registered at module load.  Call this from a plugin
 * package's top-level code to add new methods or replace existing ones.
 * Last registration wins.
 *
 * @example
 * import { registerDeployMethod } from '@cpdevtools/git-flow/artifacts';
 * registerDeployMethod('docker', 'k8s', { copyFiles, generateDeployYml });
 */
export function registerDeployMethod(
  artifactType: string,
  method: string,
  handler: DeployMethodHandler,
): void {
  if (!deployMethodRegistry.has(artifactType)) {
    deployMethodRegistry.set(artifactType, new Map());
  }
  deployMethodRegistry.get(artifactType)!.set(method, handler);
}

/**
 * Look up a registered deploy method handler.  Returns undefined if not found.
 */
export function getDeployMethod(
  artifactType: string,
  method: string,
): DeployMethodHandler | undefined {
  return deployMethodRegistry.get(artifactType)?.get(method);
}

/**
 * List all registered method names for an artifact type.
 * Useful for error messages when a requested method is not registered.
 */
export function listDeployMethods(artifactType: string): string[] {
  const methods = deployMethodRegistry.get(artifactType);
  return methods ? [...methods.keys()] : [];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeName(name: string): string {
  return name.replace(/@/g, '').replace(/\//g, '-');
}

// ---------------------------------------------------------------------------
// Built-in handlers
// ---------------------------------------------------------------------------

// ── docker.compose ─────────────────────────────────────────────────────────
registerDeployMethod('docker', 'compose', {
  async copyFiles({ projectCwd, deployOutputDir }) {
    const composeFile = join(projectCwd, 'docker-compose.yml');
    if (!existsSync(composeFile)) {
      throw new Error(`docker.compose: docker-compose.yml not found in ${projectCwd}`);
    }
    await mkdir(deployOutputDir, { recursive: true });
    await copyFile(composeFile, join(deployOutputDir, 'docker-compose.yml'));
    // Copy docker-compose.*.yml override files
    const all = await readdir(projectCwd);
    for (const file of all) {
      if (
        file.startsWith('docker-compose.') &&
        file.endsWith('.yml') &&
        file !== 'docker-compose.yml'
      ) {
        await copyFile(join(projectCwd, file), join(deployOutputDir, file));
      }
    }
  },
  async generateDeployYml({ deployOutputDir }) {
    await writeFile(
      join(deployOutputDir, 'deploy.yml'),
      stringify({ deployCommand: 'docker compose pull && docker compose up -d' }),
    );
  },
});

// ── docker.swarm ───────────────────────────────────────────────────────────
registerDeployMethod('docker', 'swarm', {
  async copyFiles({ projectCwd, deployOutputDir }) {
    const stackFile = join(projectCwd, 'stack.yml');
    if (!existsSync(stackFile)) {
      throw new Error(`docker.swarm: stack.yml not found in ${projectCwd}`);
    }
    await mkdir(deployOutputDir, { recursive: true });
    await copyFile(stackFile, join(deployOutputDir, 'stack.yml'));
    // Copy stack.*.yml overlays
    const all = await readdir(projectCwd);
    for (const file of all) {
      if (file.startsWith('stack.') && file.endsWith('.yml') && file !== 'stack.yml') {
        await copyFile(join(projectCwd, file), join(deployOutputDir, file));
      }
    }
  },
  async generateDeployYml({ deployOutputDir, projectName }) {
    const stackName = safeName(projectName).replace(/-/g, '_');
    await writeFile(
      join(deployOutputDir, 'deploy.yml'),
      stringify({ deployCommand: `docker stack deploy -c stack.yml ${stackName}` }),
    );
  },
});

// ── npm.node ───────────────────────────────────────────────────────────────
registerDeployMethod('npm', 'node', {
  async copyFiles({ projectCwd, deployOutputDir }) {
    const ecoFile = join(projectCwd, 'ecosystem.config.js');
    if (!existsSync(ecoFile)) {
      throw new Error(`npm.node: ecosystem.config.js not found in ${projectCwd}`);
    }
    await mkdir(deployOutputDir, { recursive: true });
    await copyFile(ecoFile, join(deployOutputDir, 'ecosystem.config.js'));
  },
  async generateDeployYml({ deployOutputDir, projectName, version }) {
    const configAuth = [
      `npm config set "//npm.pkg.github.com/:_authToken" "$GITHUB_TOKEN"`,
      `npm config set @cpdevtools:registry https://npm.pkg.github.com`,
    ].join(' && ');
    const installCmd = `npm install -g ${projectName}@${version}`;
    await writeFile(
      join(deployOutputDir, 'deploy.yml'),
      stringify({ deployCommand: `${configAuth} && ${installCmd} && echo "\u25b8 Service restarting..." && (sleep 5 && pm2 restart ecosystem.config.js --update-env &)` }),
    );
  },
});
