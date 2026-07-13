import {
  Body,
  Controller,
  ForbiddenException,
  Get,
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

const HEARTBEAT_INTERVAL_MS = 5_000;

@Controller()
export class DeployController {
  constructor(
    private readonly store: DeployStore,
    private readonly config: ConfigService,
    private readonly repos: ReposConfigService,
  ) {}

  @Get('health')
  health(): { ok: boolean } {
    return { ok: true };
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
      res.status(200).end();
      return;
    }

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
          return;
        }
      }

      this.store.appendLine(record, `▸ Running: ${manifest.deployCommand}`);

      let exitCode: number;
      try {
        exitCode = await runDeploy(manifest, workDir, (line) => {
          this.store.appendLine(record, line);
        });
      } catch (err) {
        this.store.appendLine(record, `▸ Error: ${(err as Error).message}`);
        exitCode = 1;
      }

      this.store.finish(record, exitCode);
    })();
  }
}
