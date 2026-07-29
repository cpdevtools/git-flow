import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchDeployBundle,
  prepareSharedStorage,
  runDeploy,
  deploymentSlot,
  slotStack,
} from '@cpdevtools/git-flow-deploy';
import type { DeployManifest, DeployRequest } from '@cpdevtools/git-flow-deploy';
import { DeployStore } from './deploy-store.js';
import { HmacGuard } from './hmac.guard.js';
import { ConfigService } from './config.service.js';
import { ReposConfigService } from './repos-config.service.js';
import { DeploymentStateService, type DeploymentStateInput } from './deployment-state.service.js';
import type { DeployRecord } from './deploy-record.js';
import { getServiceInfo } from '../version.js';

const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Deploy methods under which THIS service runs inside a container that its own
 * deploy command replaces. Such a self-deploy cannot be run inline — see
 * `startSelfRedeploy`.
 */
const CONTAINERIZED_METHODS = new Set(['compose', 'swarm']);

/**
 * Env vars that describe THIS container's runtime rather than the deployment.
 * They must not be forwarded to the supervisor container, whose image has its
 * own interpreter paths and would break if we overwrote them.
 */
const SUPERVISOR_ENV_BLOCKLIST = new Set([
  'PATH',
  'HOME',
  'HOSTNAME',
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'NODE_VERSION',
  'YARN_VERSION',
]);

@Controller()
export class DeployController {
  private readonly logger = new Logger(DeployController.name);

  constructor(
    private readonly store: DeployStore,
    private readonly config: ConfigService,
    private readonly repos: ReposConfigService,
    private readonly state: DeploymentStateService,
  ) {}

  @Get('health')
  health(): { ok: boolean; name: string; version: string } {
    const { name, version } = getServiceInfo();
    return { ok: true, name, version };
  }

  @UseGuards(HmacGuard)
  @Post('deploy')
  triggerDeploy(@Body() body: DeployRequest, @Res() res: Response): void {
    const { repo, release_id: releaseId } = body;

    if (!repo || !releaseId) {
      res.status(400).end();
      return;
    }

    if (!this.repos.isAllowed(repo)) {
      res.status(403).end();
      return;
    }

    if (this.store.isRunning(releaseId)) {
      this.logger.log(`Deploy already running for release ${releaseId} — attaching observer`);
      res.status(200).end();
      return;
    }

    this.logger.log(`Deploy triggered: ${repo} release ${releaseId} bundle=${body.bundle ?? 'default'}`);
    const record = this.store.start(releaseId, repo);
    void this.runDeployAsync(record, repo, releaseId, body.bundle);
    res.status(202).end();
  }

  @Get('deploy/:id/logs')
  async streamLogs(
    @Param('id') id: string,
    @Query('from') fromParam: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const releaseId = parseInt(id, 10);
    if (isNaN(releaseId)) throw new NotFoundException();

    const record = this.store.get(releaseId);
    if (!record) throw new NotFoundException();

    const totalLines = record.log.length;
    let from: number;
    if (fromParam === undefined) {
      from = 0;
    } else {
      const parsed = parseInt(fromParam, 10);
      from = isNaN(parsed) ? 0 : parsed < 0 ? Math.max(0, totalLines + parsed) : parsed;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    // Flush buffered lines from `from` onward
    for (let i = from; i < record.log.length; i++) {
      res.write(record.log[i] + '\n');
    }

    if (record.status !== 'running') {
      res.end();
      return;
    }

    // Stream live lines
    let cursor = record.log.length;

    const onLine = (): void => {
      while (cursor < record.log.length) {
        res.write(record.log[cursor] + '\n');
        cursor++;
      }
    };

    const heartbeat = setInterval(() => {
      res.write(':hb\n');
    }, HEARTBEAT_INTERVAL_MS);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      record.signal.off('line', onLine);
      record.signal.off('done', onDone);
    };

    const onDone = (): void => {
      onLine(); // flush final lines including EXIT:*
      cleanup();
      res.end();
    };

    record.signal.on('line', onLine);
    record.signal.on('done', onDone);

    res.on('close', cleanup);
  }

  @Get('deploy/:id')
  getStatus(@Param('id') id: string): {
    release_id: number;
    repo: string;
    status: string;
    startedAt: string;
    completedAt?: string;
  } {
    const releaseId = parseInt(id, 10);
    if (isNaN(releaseId)) throw new NotFoundException();

    const record = this.store.get(releaseId);
    if (!record) throw new NotFoundException();

    return {
      release_id: record.releaseId,
      repo: record.repo,
      status: record.status,
      startedAt: record.startedAt.toISOString(),
      completedAt: record.completedAt?.toISOString(),
    };
  }

  private runDeployAsync(record: DeployRecord, repo: string, releaseId: number, bundle?: string): Promise<void> {
    return (async () => {
      const workDir = join(this.config.workDir, String(releaseId));
      const assetName = bundle ?? 'deploy.zip';

      this.store.appendLine(record, `▸ Fetching ${assetName} from release ${releaseId}...`);

      let manifest;
      try {
        manifest = await fetchDeployBundle(this.config.githubToken, repo, releaseId, workDir, assetName);
      } catch (err) {
        this.store.appendLine(record, `▸ Error: ${(err as Error).message}`);
        this.store.finish(record, 1);
        this.logger.error(`Deploy failed (fetch): ${repo} release ${releaseId} — ${(err as Error).message}`);
        return;
      }

      if (this.config.sharedStorageBaseDir && manifest.sharedStorage) {
        this.store.appendLine(
          record,
          `▸ Preparing shared storage: ${this.config.sharedStorageBaseDir}/${manifest.name}/`,
        );
        try {
          await prepareSharedStorage(manifest, this.config.sharedStorageBaseDir);
        } catch (err) {
          this.store.appendLine(record, `▸ Error: ${(err as Error).message}`);
          this.store.finish(record, 1);
          this.logger.error(`Deploy failed (storage): ${repo} release ${releaseId} — ${(err as Error).message}`);
          return;
        }
      }

      // ── Resolve the deployment slot + detect a mode change ─────────────────
      const self = getServiceInfo();
      const versioning = manifest.versioning ?? 'singleton';
      const slot = manifest.slot ?? deploymentSlot(manifest.name, manifest.version, versioning);
      const selfSlot = deploymentSlot(self.name, self.version, versioning);
      // A deploy replaces THIS process only when it targets our own slot (same
      // name AND, for major-versioned apps, the same major). A different major
      // is a parallel slot, not a self-update.
      const isSelf = manifest.name === self.name && slot === selfSlot;

      const prior = this.state.get(slot);
      const modeChange = Boolean(
        prior && prior.method && manifest.method && prior.method !== manifest.method,
      );

      // ── Self mode-change: hand off to a detached supervisor ────────────────
      // Tearing down our own current mode kills this process, so a detached
      // supervisor performs teardown → new mode → rollback and appends EXIT.
      if (isSelf && modeChange && prior) {
        this.startSelfModeChange(record, manifest, workDir, slot, versioning, prior);
        return;
      }

      // ── Other apps: on a mode change, tear the old mode down first ─────────
      if (modeChange && prior) {
        if (prior.teardownCommand) {
          this.store.appendLine(
            record,
            `▸ Mode change ${prior.method} → ${manifest.method}; tearing down previous mode…`,
          );
          this.store.appendLine(record, `▸ Running: ${prior.teardownCommand}`);
          const teardownCode = await this.runShell(record, prior.teardownCommand, prior.bundleDir);
          if (teardownCode !== 0) {
            this.store.appendLine(
              record,
              `▸ Teardown of previous mode failed (exit ${teardownCode}); aborting to avoid running two modes.`,
            );
            this.store.finish(record, 1);
            this.logger.error(`Deploy aborted (teardown failed): ${repo} release ${releaseId}`);
            return;
          }
        } else {
          this.store.appendLine(
            record,
            `▸ Mode change ${prior.method} → ${manifest.method}; previous bundle has no teardownCommand — skipping teardown (legacy).`,
          );
        }
      }

      this.store.appendLine(record, `▸ Running: ${manifest.deployCommand}`);

      // A same-slot self deploy (e.g. a node reload) restarts THIS process, so
      // running deployCommand will kill it; completion is handed off to the
      // bundle's restart supervisor, which appends the terminal EXIT to deploy.log.
      const selfUpdate = isSelf;
      if (selfUpdate) {
        this.store.setSelfUpdate(record, manifest.version);
      }

      // ── Containerized self deploy: hand off to a SIBLING container ─────────
      // Under compose/swarm the deploy command replaces the very container this
      // process runs in, and `up --force-recreate` stops the old container
      // between creating and starting the replacement. Run inline, we are
      // SIGKILLed in that window and the new container is left in `created`.
      // A `setsid` supervisor (as used for a mode change) does NOT help here:
      // it stays in this container's PID namespace and cgroup, so Docker tears
      // it down with everything else. Only a separate container survives.
      if (
        selfUpdate &&
        CONTAINERIZED_METHODS.has(manifest.method ?? '') &&
        this.startSelfRedeploy(record, manifest, workDir, slot, versioning, prior)
      ) {
        return;
      }

      let exitCode: number;
      try {
        exitCode = await runDeploy(manifest, workDir, (line) => {
          this.store.appendLine(record, line);
        });
      } catch (err) {
        this.store.appendLine(record, `▸ Error: ${(err as Error).message}`);
        exitCode = 1;
      }

      // Persist the new current deployment for this slot (also keeps a fresh copy
      // of the bundle for a future teardown). For a self-update the process is
      // about to restart, so persist now — before handing off.
      if (exitCode === 0) {
        try {
          this.state.save(this.buildState(manifest, slot, versioning), workDir);
        } catch (err) {
          this.store.appendLine(
            record,
            `▸ Warning: failed to persist deployment state: ${(err as Error).message}`,
          );
        }
      } else if (modeChange && prior) {
        // The new mode failed after the old mode was already torn down → roll back.
        this.store.appendLine(
          record,
          `▸ New mode failed (exit ${exitCode}); rolling back to ${prior.method}…`,
        );
        this.store.appendLine(record, `▸ Running: ${prior.deployCommand}`);
        const rollbackCode = await this.runShell(record, prior.deployCommand, prior.bundleDir);
        this.store.appendLine(
          record,
          rollbackCode === 0
            ? `▸ Rolled back to previous mode (${prior.method}).`
            : `▸ Rollback FAILED (exit ${rollbackCode}); manual intervention required.`,
        );
      }

      if (selfUpdate && exitCode === 0) {
        // Hand off to the restart supervisor: do NOT finish here. The supervisor
        // appends its restart/health output and the terminal EXIT to deploy.log;
        // tailing streams it through to any (reconnecting) client until EXIT.
        this.store.appendLine(
          record,
          '▸ Deploy command handed off to restart supervisor; awaiting service restart…',
        );
        this.store.startTail(record);
        this.logger.log(`Deploy handed off to restart supervisor: ${repo} release ${releaseId}`);
        return;
      }

      this.store.finish(record, exitCode);
      if (exitCode === 0) {
        this.logger.log(`Deploy completed: ${repo} release ${releaseId}`);
      } else {
        this.logger.error(`Deploy failed: ${repo} release ${releaseId} (exit ${exitCode})`);
      }
    })();
  }

  /** Run a shell command from a bundle dir, streaming output into the record's log. */
  private runShell(record: DeployRecord, command: string, cwd: string): Promise<number> {
    return runDeploy({ deployCommand: command }, cwd, (line) => this.store.appendLine(record, line));
  }

  /** Build the durable state to persist for a successful deploy. */
  private buildState(
    manifest: DeployManifest,
    slot: string,
    versioning: 'singleton' | 'major',
  ): DeploymentStateInput {
    return {
      slot,
      name: manifest.name,
      method: manifest.method ?? 'unknown',
      version: manifest.version,
      releaseId: manifest.releaseId,
      versioning,
      teardownCommand: manifest.teardownCommand,
      deployCommand: manifest.deployCommand,
    };
  }

  /**
   * Hand a self mode-change (the deploy-service switching its own runtime, e.g.
   * node → compose) to a detached supervisor. Tearing down the current mode
   * kills this process, so the supervisor (a new session via setsid) performs
   * teardown-old → bring-up-new → rollback-on-failure and appends the terminal
   * EXIT to deploy.log, which the restarted/surviving service tails to finalize.
   */
  private startSelfModeChange(
    record: DeployRecord,
    manifest: DeployManifest,
    workDir: string,
    slot: string,
    versioning: 'singleton' | 'major',
    prior: { method: string; bundleDir: string; teardownCommand?: string; deployCommand: string },
  ): void {
    this.store.setSelfUpdate(record, manifest.version);

    const stateNew = this.state.stageState(this.buildState(manifest, slot, versioning));
    const scriptPath = join(workDir, 'self-mode-change.sh');
    try {
      writeFileSync(scriptPath, SELF_MODE_CHANGE_SCRIPT, { mode: 0o755 });
    } catch (err) {
      this.store.appendLine(record, `▸ Error: failed to write supervisor script: ${(err as Error).message}`);
      this.store.finish(record, 1);
      return;
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GFMC_LOG: join(workDir, 'deploy.log'),
      GFMC_FROM: prior.method,
      GFMC_TO: manifest.method ?? 'unknown',
      GFMC_TEARDOWN_CWD: prior.bundleDir,
      GFMC_TEARDOWN_CMD: prior.teardownCommand ?? '',
      GFMC_ROLLBACK_CMD: prior.deployCommand,
      GFMC_DEPLOY_CWD: workDir,
      GFMC_DEPLOY_CMD: manifest.deployCommand,
      GFMC_CURRENT: this.state.currentBundleDir(slot),
      GFMC_NEW_BUNDLE: workDir,
      GFMC_STATE: this.state.stateFile(slot),
      GFMC_STATE_NEW: stateNew,
    };

    this.store.appendLine(
      record,
      `▸ Self mode-change ${prior.method} → ${manifest.method}; handing off to detached supervisor…`,
    );

    try {
      const child = spawn('setsid', ['sh', scriptPath], {
        cwd: workDir,
        env,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch (err) {
      this.store.appendLine(record, `▸ Error: failed to start supervisor: ${(err as Error).message}`);
      this.store.finish(record, 1);
      return;
    }

    this.store.startTail(record);
    this.logger.log(`Self mode-change handed off to supervisor: slot ${slot} ${prior.method} → ${manifest.method}`);
  }

  /**
   * Hand a same-mode containerized self deploy (compose/swarm) to a supervisor
   * running in a SIBLING container, which survives the replacement of this one.
   *
   * The supervisor inherits our bind mounts via `--volumes-from`, so the bundle
   * dir, state dir and Docker socket appear at the same paths it already has in
   * the manifest — no host-path translation needed (the host paths behind our
   * mounts are not knowable from in here). It runs OUR image, which is
   * guaranteed to be present locally and already ships the docker CLI + compose
   * plugin, so the handoff never depends on pulling a helper image.
   *
   * Returns true when the deploy has been handed off (or definitively failed) —
   * i.e. the caller must stop. Returns false when no supervisor could be
   * started, leaving the caller to run the deploy inline as a best effort.
   */
  private startSelfRedeploy(
    record: DeployRecord,
    manifest: DeployManifest,
    workDir: string,
    slot: string,
    versioning: 'singleton' | 'major',
    prior: { bundleDir: string; deployCommand: string } | undefined,
  ): boolean {
    const self = this.resolveSelfContainer(slot);
    if (!self) {
      this.store.appendLine(
        record,
        '▸ Warning: could not identify this service\'s own container; running the deploy inline. ' +
          'If it replaces this container the deploy will be killed mid-swap — set DEPLOY_SELF_CONTAINER to fix.',
      );
      return false;
    }

    const stateNew = this.state.stageState(this.buildState(manifest, slot, versioning));
    const scriptPath = join(workDir, 'self-redeploy.sh');
    try {
      writeFileSync(scriptPath, SELF_REDEPLOY_SCRIPT, { mode: 0o755 });
    } catch (err) {
      this.store.appendLine(record, `▸ Error: failed to write supervisor script: ${(err as Error).message}`);
      this.store.finish(record, 1);
      return true;
    }

    const supervisorEnv: Record<string, string> = {
      GFSR_LOG: join(workDir, 'deploy.log'),
      GFSR_VERSION: manifest.version,
      GFSR_DEPLOY_CWD: workDir,
      GFSR_DEPLOY_CMD: manifest.deployCommand,
      GFSR_ROLLBACK_CWD: prior?.bundleDir ?? '',
      GFSR_ROLLBACK_CMD: prior?.deployCommand ?? '',
      GFSR_CURRENT: this.state.currentBundleDir(slot),
      GFSR_NEW_BUNDLE: workDir,
      GFSR_STATE: this.state.stateFile(slot),
      GFSR_STATE_NEW: stateNew,
    };

    // Forward our deployment env (COMPOSE_FILE, DEPLOY_*, GITHUB_TOKEN, …) so the
    // bundle's ${VAR} interpolation resolves exactly as it would have in here.
    // Args are passed as an array, never through a shell, so values need no quoting.
    const args = ['run', '--detach', '--rm', '--volumes-from', self.id, '--workdir', workDir];
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || SUPERVISOR_ENV_BLOCKLIST.has(key)) continue;
      args.push('--env', `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(supervisorEnv)) {
      args.push('--env', `${key}=${value}`);
    }
    args.push('--entrypoint', 'sh', self.image, scriptPath);

    this.store.appendLine(
      record,
      `▸ Containerized self deploy; handing off to a sibling supervisor container (${self.image})…`,
    );

    const run = spawnSync('docker', args, { encoding: 'utf-8' });
    if (run.status !== 0) {
      this.store.appendLine(
        record,
        `▸ Error: failed to start supervisor container: ${(run.stderr || run.stdout || '').trim()}`,
      );
      this.store.finish(record, 1);
      return true;
    }

    this.store.startTail(record);
    this.logger.log(`Containerized self deploy handed off to supervisor container: slot ${slot} → v${manifest.version}`);
    return true;
  }

  /**
   * Identify the container this process runs in, so a supervisor can inherit its
   * mounts.
   *
   * The usual tricks do NOT work here. Under `network_mode: container:<other>`
   * the UTS namespace and the /etc/{hostname,hosts,resolv.conf} bind mounts all
   * come from the JOINED container, so `hostname` and /proc/self/mountinfo both
   * report that container's id instead of ours; cgroup v2 reports a bare `0::/`.
   * Asking the daemon by deployment-slot label is the only method that stays
   * correct in every mode we support — compose sets `com.docker.compose.project`
   * to the slot (we deploy with `-p <slot>`) and swarm sets
   * `com.docker.stack.namespace` to the slot's stack name.
   *
   * Requires a unique running match, so a multi-service bundle falls back rather
   * than guessing wrong. `DEPLOY_SELF_CONTAINER` overrides the lookup entirely.
   */
  private resolveSelfContainer(slot: string): { id: string; image: string } | undefined {
    const inspect = (ref: string): { id: string; image: string } | undefined => {
      const res = spawnSync('docker', ['inspect', ref, '--format', '{{.Id}} {{.Config.Image}}'], {
        encoding: 'utf-8',
      });
      if (res.status !== 0) return undefined;
      const [id, image] = res.stdout.trim().split(' ');
      return id && image ? { id, image } : undefined;
    };

    const explicit = process.env['DEPLOY_SELF_CONTAINER'];
    if (explicit) return inspect(explicit);

    const labels = [
      `com.docker.compose.project=${slot}`,
      `com.docker.stack.namespace=${slotStack(slot)}`,
    ];
    for (const label of labels) {
      const res = spawnSync(
        'docker',
        ['ps', '--no-trunc', '--filter', 'status=running', '--filter', `label=${label}`, '--format', '{{.ID}}'],
        { encoding: 'utf-8' },
      );
      if (res.status !== 0) continue;
      const ids = res.stdout.trim().split('\n').filter(Boolean);
      if (ids.length === 1) return inspect(ids[0]);
    }
    return undefined;
  }
}

/**
 * Supervisor for a same-mode containerized self deploy. Runs in a sibling
 * container (see startSelfRedeploy) so the replacement of this service's own
 * container cannot kill it. Parameters arrive via GFSR_* env vars to avoid
 * shell quoting. POSIX sh — runs under the image's busybox ash.
 */
const SELF_REDEPLOY_SCRIPT = `#!/bin/sh
set -u
LOG="$GFSR_LOG"
log() { printf '%s\\n' "$1" >> "$LOG" 2>/dev/null; }

# Let the HTTP response flush and the running record persist before we replace
# the container the deploy was requested through.
sleep 3
log "=== self redeploy $(date -u +%FT%TZ) -> v$GFSR_VERSION ==="

if ( cd "$GFSR_DEPLOY_CWD" && sh -c "$GFSR_DEPLOY_CMD" ) >> "$LOG" 2>&1; then
  rm -rf "$GFSR_CURRENT.tmp" 2>/dev/null
  cp -a "$GFSR_NEW_BUNDLE" "$GFSR_CURRENT.tmp" 2>> "$LOG"
  rm -rf "$GFSR_CURRENT" 2>/dev/null
  mv "$GFSR_CURRENT.tmp" "$GFSR_CURRENT" 2>> "$LOG"
  mv "$GFSR_STATE_NEW" "$GFSR_STATE" 2>> "$LOG"
  log "\u2713 Redeployed to v$GFSR_VERSION."
  log "EXIT:0"
else
  log "\u2717 Redeploy to v$GFSR_VERSION failed."
  rm -f "$GFSR_STATE_NEW" 2>/dev/null
  if [ -n "$GFSR_ROLLBACK_CMD" ] && [ -d "$GFSR_ROLLBACK_CWD" ]; then
    log "\u25b8 Rolling back to the previous release..."
    ( cd "$GFSR_ROLLBACK_CWD" && sh -c "$GFSR_ROLLBACK_CMD" ) >> "$LOG" 2>&1
  fi
  log "EXIT:1"
fi
`;

/**
 * Detached supervisor for a self mode-change of the deploy-service. Launched via
 * `setsid` (its own session) so it survives the teardown that kills the parent
 * process. All parameters arrive via GFMC_* env vars to avoid shell quoting.
 * POSIX sh — runs under dash on the target.
 */
const SELF_MODE_CHANGE_SCRIPT = `#!/bin/sh
set -u
LOG="$GFMC_LOG"
log() { printf '%s\\n' "$1" >> "$LOG" 2>/dev/null; }

# Let the HTTP response flush and the running record persist before we kill self.
sleep 3
log "=== self mode-change $(date -u +%FT%TZ): $GFMC_FROM -> $GFMC_TO ==="

log "\u25b8 Tearing down previous mode ($GFMC_FROM)..."
if [ -n "$GFMC_TEARDOWN_CMD" ]; then
  ( cd "$GFMC_TEARDOWN_CWD" && sh -c "$GFMC_TEARDOWN_CMD" ) >> "$LOG" 2>&1
fi

log "\u25b8 Bringing up new mode ($GFMC_TO)..."
if ( cd "$GFMC_DEPLOY_CWD" && sh -c "$GFMC_DEPLOY_CMD" ) >> "$LOG" 2>&1; then
  rm -rf "$GFMC_CURRENT.tmp" 2>/dev/null
  cp -a "$GFMC_NEW_BUNDLE" "$GFMC_CURRENT.tmp" 2>> "$LOG"
  rm -rf "$GFMC_CURRENT" 2>/dev/null
  mv "$GFMC_CURRENT.tmp" "$GFMC_CURRENT" 2>> "$LOG"
  mv "$GFMC_STATE_NEW" "$GFMC_STATE" 2>> "$LOG"
  log "\u2713 New mode ($GFMC_TO) is up."
  log "EXIT:0"
else
  log "\u2717 New mode ($GFMC_TO) failed to start; rolling back to $GFMC_FROM..."
  ( cd "$GFMC_TEARDOWN_CWD" && sh -c "$GFMC_ROLLBACK_CMD" ) >> "$LOG" 2>&1
  rm -f "$GFMC_STATE_NEW" 2>/dev/null
  log "EXIT:1"
fi
`;
