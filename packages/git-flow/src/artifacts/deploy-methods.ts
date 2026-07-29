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

/**
 * Restart supervisor bundled into every npm.node deploy (written as restart.sh).
 *
 * The pm2 restart swaps the service onto the freshly-installed version, which
 * KILLS this very process (the service is what's running the deploy). To
 * survive, the supervisor re-execs itself in a new session (setsid) and writes
 * ALL output to a durable, timestamped log file — output is NEVER discarded.
 * After restarting it polls /health and, when the service reports a version,
 * verifies it matches the deployed version so a failed/partial restart is
 * recorded instead of silently reported as success.
 */
const NODE_RESTART_SCRIPT = `#!/bin/sh
# Supervised restart for a node (npm + pm2) deploy. Output is NEVER discarded:
# the detached supervisor appends everything — plus the terminal EXIT line — to
# the release's deploy.log, the same file the deploy service streams/tails, so a
# self-update's restart + health verification survive the restart and stay
# visible in the workflow via the reconnect mechanism.
set -u

VERSION="\${1:-}"
NPM_PREFIX="\${GITFLOW_NPM_PREFIX:-$HOME/.npm-global}"
# Resolve the pm2 executable robustly. Prefer an explicit path (phase 1 passes
# the resolved path to the detached phase 2 via GITFLOW_PM2), then PATH, then
# common install locations — so the detached restart never dies with
# "pm2: not found" under a minimal PATH or an unexpected install prefix.
PM2="\${GITFLOW_PM2:-}"
if [ -z "$PM2" ]; then
  PM2=$(command -v pm2 2>/dev/null || true)
fi
if [ -z "$PM2" ]; then
  for _c in "$NPM_PREFIX/bin/pm2" "$HOME/.npm-global/bin/pm2" "$HOME/.local/share/pnpm/pm2" /usr/local/bin/pm2 /usr/bin/pm2; do
    if [ -x "$_c" ]; then PM2="$_c"; break; fi
  done
fi
PORT="\${PORT:-3700}"
# The reconnectable, release_id-keyed log. Defaults to ./deploy.log because the
# deploy command runs with cwd = the release working dir (where the service also
# created deploy.log). GITFLOW_DEPLOY_LOG overrides it.
DEPLOY_LOG="\${GITFLOW_DEPLOY_LOG:-$PWD/deploy.log}"

# Phase 1 (attached): launch the detached supervisor, then return promptly so the
# deploy command exits and the service can hand off. This phase's stdout is
# captured by the service and already lands in deploy.log.
if [ "\${GITFLOW_RESTART_DETACHED:-}" != "1" ]; then
  echo "▸ Restart running in background (survives the restart); output continues in this log."
  GITFLOW_RESTART_DETACHED=1 GITFLOW_DEPLOY_LOG="$DEPLOY_LOG" GITFLOW_PM2="$PM2" setsid sh "$0" "$VERSION" >>"$DEPLOY_LOG" 2>&1 </dev/null &
  exit 0
fi

# Phase 2 (detached): restart + verify. stdout/stderr are appended to deploy.log
# (redirected by phase 1), and we append the terminal EXIT:<code> line here so
# the (restarted) service's tailer finalizes the deploy from the log.
echo "=== restart $(date -u +%FT%TZ) -> v\${VERSION:-?} ==="

# Give the deploy's HTTP response / log stream a moment to flush and the service
# to record the handoff before we kill it.
sleep 3

# Restart by app name (reuses the running app's absolute script path) when it can
# be resolved from ecosystem.config.js; otherwise fall back to the config file.
# Final guard: if the resolved path isn't executable, try a bare PATH lookup,
# otherwise fail fast with a clear message and terminal EXIT so the tailer stops.
if [ -z "$PM2" ] || [ ! -x "$PM2" ]; then
  if command -v pm2 >/dev/null 2>&1; then
    PM2=pm2
  else
    echo "✗ pm2 executable not found (checked GITFLOW_PM2, PATH, $NPM_PREFIX/bin, ~/.local/share/pnpm, /usr/local/bin, /usr/bin)"
    echo "EXIT:127"
    exit 127
  fi
fi

APP=$(node -e "try{const c=require(process.cwd()+'/ecosystem.config.js');const a=((c&&c.apps)||(c&&c.default&&c.default.apps)||[])[0];process.stdout.write((a&&a.name)||'')}catch(e){}" 2>/dev/null)
if [ -n "$APP" ]; then
  echo "▸ pm2 restart $APP --update-env"
  "$PM2" restart "$APP" --update-env
else
  echo "▸ pm2 restart ecosystem.config.js --update-env"
  "$PM2" restart ecosystem.config.js --update-env
fi
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "✗ pm2 restart exited $rc"
  echo "EXIT:$rc"
  exit "$rc"
fi

echo "▸ Verifying /health on 127.0.0.1:$PORT ..."
code=""
got=""
i=0
while [ "$i" -lt 30 ]; do
  i=$((i + 1))
  sleep 2
  body=$(node -e "fetch('http://127.0.0.1:$PORT/health').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))" 2>/dev/null) || { echo "  [$i] no response yet"; continue; }
  echo "  [$i] health: $body"
  got=$(printf '%s' "$body" | sed -n 's/.*"version"[": ]*"\\([^"]*\\)".*/\\1/p')
  if [ -z "$got" ]; then
    echo "✓ Service healthy (no version reported by /health)."
    code=0
    break
  fi
  if [ "$got" = "$VERSION" ]; then
    echo "✓ Restart verified: now running v$got."
    code=0
    break
  fi
  echo "✗ Version mismatch: /health reports v$got, expected v$VERSION."
  code=1
  break
done

if [ -z "$code" ]; then
  echo "⚠ Restart issued but /health did not confirm within timeout."
  code=0
fi

echo "EXIT:$code"
exit "$code"
`;

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
    await writeFile(join(deployOutputDir, 'restart.sh'), NODE_RESTART_SCRIPT);
    await writeFile(
      join(deployOutputDir, 'deploy.yml'),
      stringify({
        deployCommand: `${prefixExpr} && ${configAuth} && ${installCmd} && echo "▸ Service updated; restarting (supervised)..." && sh ./restart.sh "${version}"`,
      }),
    );
  },
});
