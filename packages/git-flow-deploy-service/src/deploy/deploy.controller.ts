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
import { join } from 'node:path';
import { fetchDeployBundle, prepareSharedStorage, runDeploy } from '@cpdevtools/git-flow-deploy';
import type { DeployRequest } from '@cpdevtools/git-flow-deploy';
import { DeployStore } from './deploy-store.js';
import { HmacGuard } from './hmac.guard.js';
import { ConfigService } from './config.service.js';
import { ReposConfigService } from './repos-config.service.js';
import type { DeployRecord } from './deploy-record.js';
import { getServiceInfo } from '../version.js';

const HEARTBEAT_INTERVAL_MS = 5_000;

@Controller()
export class DeployController {
  private readonly logger = new Logger(DeployController.name);

  constructor(
    private readonly store: DeployStore,
    private readonly config: ConfigService,
    private readonly repos: ReposConfigService,
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
    this.runDeployAsync(record, repo, releaseId, body.bundle);
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

  private runDeployAsync(record: DeployRecord, repo: string, releaseId: number, bundle?: string): void {
    (async () => {
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

      this.store.appendLine(record, `▸ Running: ${manifest.deployCommand}`);

      // Detect a self-update: this deploy is installing the deploy-service's own
      // package, so running deployCommand will restart (kill) THIS process. When
      // that's the case the runDeploy child exits early (it backgrounds a restart
      // supervisor); completion + the terminal EXIT are owned by that supervisor,
      // which appends them to the shared deploy.log for the restarted service to tail.
      const selfUpdate = manifest.name === getServiceInfo().name;
      if (selfUpdate) {
        this.store.setSelfUpdate(record);
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
}
