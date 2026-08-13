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
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { BUILTIN_PROVIDER, ProviderRegistry, type PluginAnchor } from './provider-registry.js';
import { deploymentSlot, type VersioningStrategy } from './slot.js';

/**
 * Upsert variables into the bundle's `.env`.
 *
 * `docker compose` auto-loads `.env` from the project directory — which is the
 * bundle extraction dir, since runDeploy spawns deployCommand with cwd set there.
 * `docker stack deploy` does NOT auto-load `.env`, so the swarm deployCommand
 * explicitly sources it with `. ./.env` first.
 *
 * Existing keys are replaced and unrelated lines preserved, so a project shipping
 * its own `.env` in a .deploy/{method}/ override folder isn't clobbered.
 */
async function upsertDeployEnv(
  deployOutputDir: string,
  vars: Record<string, string>,
): Promise<void> {
  const envPath = join(deployOutputDir, '.env');
  const existing = existsSync(envPath) ? await readFile(envPath, 'utf8') : '';
  const kept = existing
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .filter((line) => !Object.keys(vars).some((k) => line.startsWith(`${k}=`)));
  const added = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  await writeFile(envPath, [...kept, ...added].join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeployMethodContext {
  /** Absolute path to the project root */
  projectCwd: string;
  /**
   * Absolute path to the workspace root, so a handler can reach files outside
   * its own project without guessing at `..` depth.
   */
  workspaceRoot: string;
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
  /**
   * Shared stack this artifact deploys into, when it does not get one of its
   * own. Set means other services live alongside it and must survive teardown.
   */
  stack?: string;
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

  /**
   * Whether this method can run two majors of the same service side by side
   * (`versioning: major`).
   *
   * A capability rather than a hardcoded method-name check in the orchestrator,
   * so a plugin can support it without being added to a list inside git-flow.
   * Defaults to false: parallel majors require the handler to derive every
   * shared identity — service name, published ports, volume names — from the
   * deployment slot, and one that has not done that work would silently collide
   * with the major already deployed.
   */
  supportsParallelMajors?: boolean;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Keyed `artifactType.method`, because a deploy method is never global — 'swarm'
 * means something different for a docker artifact than it would for any other.
 * The provider dimension is handled by ProviderRegistry.
 */
const deployMethodRegistry = new ProviderRegistry<DeployMethodHandler>('deploy method');

const methodKey = (artifactType: string, method: string) => `${artifactType}.${method}`;

/**
 * Register a deploy method handler for a given artifact type.
 *
 * Built-in handlers register at module load under the git-flow provider.
 * Plugins are registered by the loader from their exported manifest — see
 * plugin.ts for why a plugin does not call this itself.
 */
export function registerDeployMethod(
  artifactType: string,
  method: string,
  handler: DeployMethodHandler,
  provider: string = BUILTIN_PROVIDER,
  anchor: PluginAnchor = 'builtin',
): void {
  deployMethodRegistry.register(methodKey(artifactType, method), handler, provider, anchor);
}

/**
 * Look up a deploy method handler.  Returns undefined if none is registered.
 *
 * Throws when two plugins at the same level supply the method and `provider`
 * does not say which to use.
 */
export function getDeployMethod(
  artifactType: string,
  method: string,
  provider?: string,
): DeployMethodHandler | undefined {
  return deployMethodRegistry.resolve(methodKey(artifactType, method), provider);
}

/**
 * List all registered method names for an artifact type.
 * Useful for error messages when a requested method is not registered.
 */
export function listDeployMethods(artifactType: string): string[] {
  const prefix = `${artifactType}.`;
  return deployMethodRegistry
    .keys()
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}

/** Packages supplying a given method — for disambiguation error messages. */
export function listDeployMethodProviders(artifactType: string, method: string): string[] {
  return deployMethodRegistry.providersOf(methodKey(artifactType, method));
}

// ---------------------------------------------------------------------------
// Built-in handlers
// ---------------------------------------------------------------------------

// ── docker.compose ─────────────────────────────────────────────────────────
registerDeployMethod('docker', 'compose', {
  supportsParallelMajors: true,
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
    // Pin the image to THIS release. Compose files reference
    // ${DEPLOY_IMAGE_TAG} with no default, so a missing tag fails loudly rather
    // than silently deploying whatever `latest` happens to point at.
    await upsertDeployEnv(deployOutputDir, { DEPLOY_IMAGE_TAG: version });
    await writeFile(
      join(deployOutputDir, 'deploy.yml'),
      stringify({
        method: 'compose',
        slot,
        versioning: versioning ?? 'singleton',
        // --force-recreate: a previous failed `up` (e.g. the port was still held
        // during a mode change) leaves a container stuck in `Created` state.
        // A later `up` REUSES that stale container and starts it without its
        // host port mapping ever being established — the service then runs but
        // is unreachable, so the deploy "succeeds" while health checks fail.
        // Recreating unconditionally keeps each deploy deterministic.
        deployCommand: `echo "$GITHUB_TOKEN" | docker login ghcr.io -u token --password-stdin 2>/dev/null; docker compose -p ${slot} pull && docker compose -p ${slot} up -d --force-recreate --remove-orphans`,
        teardownCommand: `docker compose -p ${slot} down`,
      }),
    );
  },
});

// ── docker.swarm ───────────────────────────────────────────────────────────

/**
 * Environment variable naming the `stack.<env>.yml` overlay to merge, if any.
 */
export const SWARM_STACK_ENV_VAR = 'DEPLOY_STACK_ENV';

/**
 * Swarm deploy command baked into every generated deploy.yml.
 *
 * `@{ STACK }` is resolved at pack time; `$DEPLOY_STACK_ENV` is resolved by the
 * shell at deploy time, so one bundle can target several environments.
 */
export const SWARM_DEPLOY_COMMAND = [
  'set -a && . ./.env && set +a',
  '&& echo "$GITHUB_TOKEN" | docker login ghcr.io -u token --password-stdin 2>/dev/null;',
  'STACK_FILES="-c stack.yml";',
  `if [ -n "$${SWARM_STACK_ENV_VAR}" ]; then`,
  `[ -f "stack.$${SWARM_STACK_ENV_VAR}.yml" ] ||`,
  `{ echo "deploy: stack.$${SWARM_STACK_ENV_VAR}.yml not found in bundle" >&2; exit 1; };`,
  `STACK_FILES="$STACK_FILES -c stack.$${SWARM_STACK_ENV_VAR}.yml";`,
  'fi;',
  'docker stack deploy --with-registry-auth $STACK_FILES @{ STACK }',
].join(' ');

registerDeployMethod('docker', 'swarm', {
  supportsParallelMajors: true,
  async copyFiles({ projectCwd, deployOutputDir }) {
    const stackFile = join(projectCwd, 'stack.yml');
    if (!existsSync(stackFile)) {
      throw new Error(`docker.swarm: stack.yml not found in ${projectCwd}`);
    }
    await mkdir(deployOutputDir, { recursive: true });
    await copyFile(stackFile, join(deployOutputDir, 'stack.yml'));
    // stack.<env>.yml overlays — the deployCommand merges one of these on top of
    // stack.yml when DEPLOY_STACK_ENV names it.
    const all = await readdir(projectCwd);
    for (const file of all) {
      if (file.startsWith('stack.') && file.endsWith('.yml') && file !== 'stack.yml') {
        await copyFile(join(projectCwd, file), join(deployOutputDir, file));
      }
    }
  },
  async generateDeployYml({ deployOutputDir, projectName, version, versioning, stack }) {
    await upsertDeployEnv(deployOutputDir, { DEPLOY_IMAGE_TAG: version });
    await writeFile(
      join(deployOutputDir, 'deploy.yml'),
      stringify({
        method: 'swarm',
        slot: deploymentSlot(projectName, version, versioning),
        versioning: versioning ?? 'singleton',
        // @{ SERVICE_ID } and @{ STACK } are rendered at pack time by
        // renderDeployTemplates — they resolve correctly in YAML map keys
        // (where runtime ${VAR} interpolation does not work) and let
        // projects use them in stack.yml service names too.
        //
        // DEPLOY_STACK_ENV merges stack.<env>.yml over stack.yml. Docker only
        // creates the config/secret objects declared in the files it is given, so
        // per-env objects belong in an overlay: declaring every env in stack.yml
        // would create all of them on every deploy regardless of which is mounted.
        // A named-but-missing overlay is fatal — silently deploying without an
        // env's configs is worse than failing.
        //
        // --with-registry-auth ships the manager's registry credentials to the
        // nodes along with the service spec. Deploys land on a manager but the
        // tasks run on workers, which have no login of their own — without it a
        // private/internal image pull fails on every worker while the deploy
        // itself reports success.
        deployCommand: SWARM_DEPLOY_COMMAND,
        // The docker service name (`docker service ls`), rendered at pack time.
        // The deploy side waits on this for the rolling update to converge.
        swarmService: `@{ STACK_SERVICE_ID }`,
        // A shared stack holds other services, so removing it would take them
        // down too; drop just this service instead.
        teardownCommand: stack
          ? `docker service rm @{ STACK_SERVICE_ID }`
          : `docker stack rm @{ STACK }`,
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
    // release's deploy.log (never /dev/null), and verifies /status reports the
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
        // Stop (not delete) so the app stays REGISTERED with pm2: rollback and
        // the restart supervisor revive it by name, reusing the absolute script
        // path pm2 recorded at first start (the bundle's ecosystem.config.js only
        // has a relative path). `pm2 delete` breaks that with "Process not found".
        teardownCommand: `pm2 stop ecosystem.config.js`,
      }),
    );
  },
});
