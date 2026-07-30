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
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchDeployBundle,
  prepareSharedStorage,
  runDeploy,
  deploymentSlot,
  slotStack,
} from '@cpdevtools/git-flow-deploy';
import type {
  DeployManifest,
  DeployRequest,
} from '@cpdevtools/git-flow-deploy';
import { DeployStore } from './deploy-store.js';
import { HmacGuard } from './hmac.guard.js';
import { ConfigService } from './config.service.js';
import { ReposConfigService } from './repos-config.service.js';
import {
  DeploymentStateService,
  type DeploymentStateInput,
} from './deployment-state.service.js';
import type { DeployRecord } from './deploy-record.js';
import { getServiceInfo } from '../version.js';
import {
  CONTAINERIZED_METHODS,
  launchBare,
  launchContainer,
  supervisorPlacement,
  type ContainerTarget,
  type SupervisorPlacement,
} from '../supervisor/launcher.js';
import {
  SUPERVISOR_DELAY_MS,
  SUPERVISOR_PLAN_FILE,
  type SupervisorPlan,
} from '../supervisor/plan.js';

const HEARTBEAT_INTERVAL_MS = 5_000;

/** Outcome of trying to hand a self-replacing deploy to the supervisor. */
type HandoffOutcome =
  /** Supervisor is running; it owns the deploy and will append EXIT. */
  | 'started'
  /** A sibling container was required but this container is unidentifiable. */
  | 'no-container'
  /** The handoff failed and the record has already been finalized. */
  | 'failed';

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
      this.logger.log(
        `Deploy already running for release ${releaseId} — attaching observer`,
      );
      res.status(200).end();
      return;
    }

    this.logger.log(
      `Deploy triggered: ${repo} release ${releaseId} bundle=${body.bundle ?? 'default'}`,
    );
    const record = this.store.start(releaseId, repo);
    void this.runDeployAsync(record, repo, releaseId, body.bundle, body.env);
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
      from = isNaN(parsed)
        ? 0
        : parsed < 0
          ? Math.max(0, totalLines + parsed)
          : parsed;
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

  private runDeployAsync(
    record: DeployRecord,
    repo: string,
    releaseId: number,
    bundle?: string,
    env?: Record<string, string>,
  ): Promise<void> {
    return (async () => {
      const workDir = join(this.config.workDir, String(releaseId));
      const assetName = bundle ?? 'deploy.zip';

      this.store.appendLine(
        record,
        `▸ Fetching ${assetName} from release ${releaseId}...`,
      );

      let manifest;
      try {
        manifest = await fetchDeployBundle(
          this.config.githubToken,
          repo,
          releaseId,
          workDir,
          assetName,
        );
      } catch (err) {
        this.store.appendLine(record, `▸ Error: ${(err as Error).message}`);
        this.store.finish(record, 1);
        this.logger.error(
          `Deploy failed (fetch): ${repo} release ${releaseId} — ${(err as Error).message}`,
        );
        return;
      }

      if (this.config.sharedStorageBaseDir && manifest.sharedStorage) {
        this.store.appendLine(
          record,
          `▸ Preparing shared storage: ${this.config.sharedStorageBaseDir}/${manifest.name}/`,
        );
        try {
          await prepareSharedStorage(
            manifest,
            this.config.sharedStorageBaseDir,
          );
        } catch (err) {
          this.store.appendLine(record, `▸ Error: ${(err as Error).message}`);
          this.store.finish(record, 1);
          this.logger.error(
            `Deploy failed (storage): ${repo} release ${releaseId} — ${(err as Error).message}`,
          );
          return;
        }
      }

      // ── Resolve the deployment slot + detect a mode change ─────────────────
      const self = getServiceInfo();
      const versioning = manifest.versioning ?? 'singleton';
      const slot =
        manifest.slot ??
        deploymentSlot(manifest.name, manifest.version, versioning);
      const selfSlot = deploymentSlot(self.name, self.version, versioning);
      // A deploy replaces THIS process only when it targets our own slot (same
      // name AND, for major-versioned apps, the same major). A different major
      // is a parallel slot, not a self-update.
      const isSelf = manifest.name === self.name && slot === selfSlot;

      const prior = this.state.get(slot);
      const modeChange = Boolean(
        prior &&
        prior.method &&
        manifest.method &&
        prior.method !== manifest.method,
      );

      // ── Self mode-change: hand off to a detached supervisor ────────────────
      // Tearing down our own current mode kills this process, so a detached
      // supervisor performs teardown → new mode → rollback and appends EXIT.
      if (isSelf && modeChange && prior) {
        this.startSelfModeChange(
          record,
          manifest,
          workDir,
          slot,
          versioning,
          prior,
          env,
        );
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
          const teardownCode = await this.runShell(
            record,
            prior.teardownCommand,
            prior.bundleDir,
            env,
          );
          if (teardownCode !== 0) {
            this.store.appendLine(
              record,
              `▸ Teardown of previous mode failed (exit ${teardownCode}); aborting to avoid running two modes.`,
            );
            this.store.finish(record, 1);
            this.logger.error(
              `Deploy aborted (teardown failed): ${repo} release ${releaseId}`,
            );
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
        this.startSelfRedeploy(
          record,
          manifest,
          workDir,
          slot,
          versioning,
          prior,
          env,
        )
      ) {
        return;
      }

      let exitCode: number;
      try {
        exitCode = await runDeploy(
          manifest,
          workDir,
          (line) => {
            this.store.appendLine(record, line);
          },
          env,
        );
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
        const rollbackCode = await this.runShell(
          record,
          prior.deployCommand,
          prior.bundleDir,
          env,
        );
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
        this.logger.log(
          `Deploy handed off to restart supervisor: ${repo} release ${releaseId}`,
        );
        return;
      }

      this.store.finish(record, exitCode);
      if (exitCode === 0) {
        this.logger.log(`Deploy completed: ${repo} release ${releaseId}`);
      } else {
        this.logger.error(
          `Deploy failed: ${repo} release ${releaseId} (exit ${exitCode})`,
        );
      }
    })();
  }

  /** Run a shell command from a bundle dir, streaming output into the record's log. */
  private runShell(
    record: DeployRecord,
    command: string,
    cwd: string,
    env?: Record<string, string>,
  ): Promise<number> {
    return runDeploy(
      { deployCommand: command },
      cwd,
      (line) => this.store.appendLine(record, line),
      env,
    );
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
   * node → compose) to the supervisor. Tearing down the current mode kills this
   * process, so the supervisor performs teardown-old → bring-up-new →
   * rollback-on-failure and appends the terminal EXIT to deploy.log, which the
   * restarted/surviving service tails to finalize.
   */
  private startSelfModeChange(
    record: DeployRecord,
    manifest: DeployManifest,
    workDir: string,
    slot: string,
    versioning: 'singleton' | 'major',
    prior: {
      method: string;
      bundleDir: string;
      teardownCommand?: string;
      deployCommand: string;
    },
    env?: Record<string, string>,
  ): void {
    const from = prior.method;
    const to = manifest.method ?? 'unknown';
    const placement = supervisorPlacement(from, to);

    // Refuse BEFORE anything is torn down — the service keeps running as it is.
    if (placement === 'unsupported') {
      this.refuseModeChange(record, from, to, manifest.version);
      return;
    }

    this.store.setSelfUpdate(record, manifest.version);

    const plan: SupervisorPlan = {
      log: join(workDir, 'deploy.log'),
      slot,
      version: manifest.version,
      label: `self mode-change ${from} → ${to} (v${manifest.version})`,
      delayMs: SUPERVISOR_DELAY_MS,
      teardown: prior.teardownCommand
        ? { cwd: prior.bundleDir, command: prior.teardownCommand }
        : undefined,
      deploy: { cwd: workDir, command: manifest.deployCommand },
      rollback: { cwd: prior.bundleDir, command: prior.deployCommand },
      commit: {
        currentDir: this.state.currentBundleDir(slot),
        newBundle: workDir,
        stateFile: this.state.stateFile(slot),
        stateNewFile: this.state.stageState(
          this.buildState(manifest, slot, versioning),
        ),
      },
      env,
    };

    this.store.appendLine(
      record,
      `▸ Self mode-change ${from} → ${to}; handing off to a supervisor…`,
    );

    const outcome = this.startSupervisor(
      record,
      workDir,
      slot,
      placement,
      plan,
    );
    if (outcome === 'no-container') {
      // Running the teardown inline would SIGKILL us mid-change and leave the
      // service down with nothing to bring it back. Refuse instead.
      rmSync(plan.commit.stateNewFile, { force: true });
      this.store.appendLine(
        record,
        "▸ Error: could not identify this service's own container, so no supervisor could be started. " +
          'Nothing was torn down — set DEPLOY_SELF_CONTAINER and retry.',
      );
      this.store.finish(record, 1);
      return;
    }
    if (outcome === 'failed') return;

    this.logger.log(
      `Self mode-change handed off to supervisor: slot ${slot} ${from} → ${to}`,
    );
  }

  /**
   * Explain why a containerized → host mode change cannot be automated, and
   * finalize the deploy as failed WITHOUT touching the running deployment.
   *
   * The supervisor would have to install and start a process on the Docker host;
   * a container can create sibling containers but cannot reach outside Docker to
   * run npm/pm2 on the host. Attempting it tore the old mode down and then died
   * with it, taking the service offline with no way back.
   */
  private refuseModeChange(
    record: DeployRecord,
    from: string,
    to: string,
    version: string,
  ): void {
    const self = getServiceInfo();
    for (const line of [
      `▸ Unsupported mode change: ${from} → ${to}.`,
      `▸ Switching this service out of a containerized mode cannot be automated: the supervisor`,
      `  would have to install and start a process on the Docker host, which nothing running`,
      `  inside a container can do.`,
      `▸ Nothing was torn down — the service is still running under ${from}.`,
      `▸ To switch, run this on the deploy host:`,
      `    npx ${self.name}@${version} --method ${to} --version ${version} \\`,
      `      --install-dir <dir> --hmac-secret <secret>`,
      `  then tear the ${from} deployment down.`,
    ]) {
      this.store.appendLine(record, line);
    }
    this.store.finish(record, 1);
    this.logger.error(
      `Deploy refused (unsupported mode change ${from} → ${to})`,
    );
  }

  /**
   * Hand a same-mode containerized self deploy (compose/swarm) to a supervisor
   * running in a SIBLING container, which survives the replacement of this one.
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
    env?: Record<string, string>,
  ): boolean {
    const plan: SupervisorPlan = {
      log: join(workDir, 'deploy.log'),
      slot,
      version: manifest.version,
      label: `self redeploy → v${manifest.version}`,
      delayMs: SUPERVISOR_DELAY_MS,
      deploy: { cwd: workDir, command: manifest.deployCommand },
      rollback: prior
        ? { cwd: prior.bundleDir, command: prior.deployCommand }
        : undefined,
      commit: {
        currentDir: this.state.currentBundleDir(slot),
        newBundle: workDir,
        stateFile: this.state.stateFile(slot),
        stateNewFile: this.state.stageState(
          this.buildState(manifest, slot, versioning),
        ),
      },
      env,
    };

    const outcome = this.startSupervisor(
      record,
      workDir,
      slot,
      'container',
      plan,
    );
    if (outcome === 'no-container') {
      rmSync(plan.commit.stateNewFile, { force: true });
      this.store.appendLine(
        record,
        "▸ Warning: could not identify this service's own container; running the deploy inline. " +
          'If it replaces this container the deploy will be killed mid-swap — set DEPLOY_SELF_CONTAINER to fix.',
      );
      return false;
    }
    if (outcome === 'started') {
      this.logger.log(
        `Containerized self deploy handed off to supervisor container: slot ${slot} → v${manifest.version}`,
      );
    }
    return true;
  }

  /**
   * Write the plan and start `gitflow-deploy-service supervise --plan <file>`
   * in the placement that survives this deploy, then tail deploy.log for the
   * supervisor's output and terminal EXIT.
   */
  private startSupervisor(
    record: DeployRecord,
    workDir: string,
    slot: string,
    placement: Exclude<SupervisorPlacement, 'unsupported'>,
    plan: SupervisorPlan,
  ): HandoffOutcome {
    let container: ContainerTarget | undefined;
    if (placement === 'container') {
      container = this.resolveSelfContainer(slot);
      if (!container) return 'no-container';
    }

    const planPath = join(workDir, SUPERVISOR_PLAN_FILE);
    try {
      writeFileSync(planPath, JSON.stringify(plan, null, 2));
    } catch (err) {
      this.store.appendLine(
        record,
        `▸ Error: failed to write the supervisor plan: ${(err as Error).message}`,
      );
      this.store.finish(record, 1);
      return 'failed';
    }

    if (container) {
      this.store.appendLine(
        record,
        `▸ Handing off to a sibling supervisor container (${container.image})…`,
      );
    }

    const result = container
      ? launchContainer(planPath, workDir, container)
      : launchBare(planPath, workDir);

    if (!result.ok) {
      this.store.appendLine(
        record,
        `▸ Error: failed to start the supervisor: ${result.error}`,
      );
      this.store.finish(record, 1);
      return 'failed';
    }

    this.store.startTail(record);
    return 'started';
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
  private resolveSelfContainer(
    slot: string,
  ): { id: string; image: string } | undefined {
    const inspect = (
      ref: string,
    ): { id: string; image: string } | undefined => {
      const res = spawnSync(
        'docker',
        ['inspect', ref, '--format', '{{.Id}} {{.Config.Image}}'],
        {
          encoding: 'utf-8',
        },
      );
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
        [
          'ps',
          '--no-trunc',
          '--filter',
          'status=running',
          '--filter',
          `label=${label}`,
          '--format',
          '{{.ID}}',
        ],
        { encoding: 'utf-8' },
      );
      if (res.status !== 0) continue;
      const ids = res.stdout.trim().split('\n').filter(Boolean);
      if (ids.length === 1) return inspect(ids[0]);
    }
    return undefined;
  }
}
