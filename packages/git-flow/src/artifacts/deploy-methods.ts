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

import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { deploymentSlot, slotStack, type VersioningStrategy } from './slot.js';

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
  /**
   * Versioning strategy for this artifact ('singleton' | 'major'). Drives the
   * deployment slot baked into resource names. Defaults to 'singleton'.
   */
  versioning?: VersioningStrategy;
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
  async generateDeployYml({ deployOutputDir, projectName, version, versioning }) {
    // Pin a stable compose project name to the deployment slot so `up` (run from
    // the /tmp/<releaseId> extraction dir) and `down` (run later from the saved
    // bundle dir on a mode change) refer to the SAME project. Without this the
    // project name defaults to the extraction dir basename and orphans containers.
    const slot = deploymentSlot(projectName, version, versioning);
    await writeFile(
      join(deployOutputDir, 'deploy.yml'),
      stringify({
        method: 'compose',
        slot,
        versioning: versioning ?? 'singleton',
        deployCommand: `docker compose -p ${slot} pull && docker compose -p ${slot} up -d`,
        teardownCommand: `docker compose -p ${slot} down`,
      }),
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
  async generateDeployYml({ deployOutputDir, projectName, version, versioning }) {
    const stackName = slotStack(deploymentSlot(projectName, version, versioning));
    await writeFile(
      join(deployOutputDir, 'deploy.yml'),
      stringify({
        method: 'swarm',
        slot: deploymentSlot(projectName, version, versioning),
        versioning: versioning ?? 'singleton',
        deployCommand: `docker stack deploy -c stack.yml ${stackName}`,
        teardownCommand: `docker stack rm ${stackName}`,
      }),
    );
  },
});

// ── npm.node ───────────────────────────────────────────────────────────────

/**
 * Restart supervisor bundled into every npm.node deploy (written as restart.sh).
 *
 * The pm2 restart swaps the service onto the freshly-installed version, which
 * KILLS this very process (the service is what's running the deploy). To
 * survive, the supervisor re-execs itself in a new session (setsid) and appends
 * ALL output — plus the terminal EXIT line — to the release's deploy.log, the
 * same file the deploy service streams/tails, so the restart + health
 * verification stay visible in the workflow via the reconnect mechanism.
 *
 * The script lives as a real shell file (src/artifacts/restart.sh) so it gets
 * shellcheck + syntax highlighting and avoids template-literal escaping bugs.
 * It's read verbatim at runtime and written into each deploy bundle. tsup copies
 * it next to dist/artifacts/index.js (see tsup.config.ts) so __dirname resolves
 * it in both source (tsx, loaded as cjs) and built (dist cjs) execution.
 */
let cachedRestartScript: string | undefined;
function loadRestartScript(): string {
  if (cachedRestartScript === undefined) {
    cachedRestartScript = readFileSync(join(__dirname, 'restart.sh'), 'utf8');
  }
  return cachedRestartScript;
}

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
    // Install into a user-writable prefix (defaults to ~/.npm-global, matching
    // the self-installer) so the unprivileged service user can update itself
    // without EACCES on the root-owned global node_modules. GITFLOW_NPM_PREFIX
    // (exported by the service) overrides the default.
    const prefixExpr = `NPM_PREFIX="\${GITFLOW_NPM_PREFIX:-$HOME/.npm-global}"`;
    const installCmd = `npm install -g --prefix "$NPM_PREFIX" ${projectName}@${version}`;
    // restart.sh supervises the pm2 restart: it survives the restart that kills
    // this process, appends ALL output plus the terminal EXIT line to the
    // release's deploy.log (never /dev/null), and verifies /health reports the
    // new version. The service tails that same deploy.log to finalize the deploy.
    // The script is a real shell asset (src/artifacts/restart.sh), read verbatim.
    await writeFile(join(deployOutputDir, 'restart.sh'), loadRestartScript());
    await writeFile(
      join(deployOutputDir, 'deploy.yml'),
      stringify({
        method: 'node',
        // node is singleton-only for now (parallel-major deferred): the pm2 app
        // identity lives in the author's ecosystem.config.js. Teardown stops
        // exactly the apps that file defined, run from the saved bundle dir.
        slot: deploymentSlot(projectName, version, 'singleton'),
        versioning: 'singleton',
        deployCommand: `${prefixExpr} && ${configAuth} && ${installCmd} && echo "▸ Service updated; restarting (supervised)..." && sh ./restart.sh "${version}"`,
        // Stop (not delete) frees the port in fork mode while keeping the app
        // registered with pm2, so a rollback can revive it by name (reusing the
        // absolute script path pm2 recorded at first start). Run from the saved
        // bundle dir, which holds this exact ecosystem.config.js.
        teardownCommand: `pm2 stop ecosystem.config.js`,
      }),
    );
  },
});
