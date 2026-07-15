import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeployRecord, DeployStatus } from './deploy-record.js';

interface PersistedRecord {
  releaseId: number;
  repo: string;
  status: DeployStatus;
  startedAt: string;
  completedAt?: string;
  log: string[];
}

@Injectable()
export class DeployStore implements OnModuleInit {
  private readonly records = new Map<number, DeployRecord>();
  private readonly workDir: string = process.env['DEPLOY_WORK_DIR'] ?? '/tmp/deployments';

  onModuleInit(): void {
    this.loadPersistedRecords();
  }

  private recordPath(releaseId: number): string {
    return join(this.workDir, String(releaseId), 'deploy-record.json');
  }

  private persist(record: DeployRecord): void {
    try {
      mkdirSync(join(this.workDir, String(record.releaseId)), { recursive: true });
      const data: PersistedRecord = {
        releaseId: record.releaseId,
        repo: record.repo,
        status: record.status,
        startedAt: record.startedAt.toISOString(),
        completedAt: record.completedAt?.toISOString(),
        log: record.log,
      };
      writeFileSync(this.recordPath(record.releaseId), JSON.stringify(data));
    } catch {
      // Best-effort — don't crash on persist failure
    }
  }

  private loadPersistedRecords(): void {
    try {
      if (!existsSync(this.workDir)) return;
      for (const entry of readdirSync(this.workDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const recordFile = join(this.workDir, entry.name, 'deploy-record.json');
        if (!existsSync(recordFile)) continue;
        try {
          const data: PersistedRecord = JSON.parse(readFileSync(recordFile, 'utf-8'));
          const record: DeployRecord = {
            releaseId: data.releaseId,
            repo: data.repo,
            // If it was 'running' when we died, mark failed
            status: data.status === 'running' ? 'failed' : data.status,
            startedAt: new Date(data.startedAt),
            completedAt: data.completedAt ? new Date(data.completedAt) : undefined,
            log: [...data.log],
            signal: new EventEmitter(),
          };
          record.signal.setMaxListeners(100);
          if (data.status === 'running' && !data.log.some(l => l.startsWith('EXIT:'))) {
            record.log.push('▸ Service restarted during deploy — resuming log from disk');
            record.log.push('EXIT:0');
          }
          this.records.set(record.releaseId, record);
        } catch {
          // Skip malformed record
        }
      }
    } catch {
      // Best-effort
    }
  }

  get(releaseId: number): DeployRecord | undefined {
    return this.records.get(releaseId);
  }

  /**
   * Create a new record in 'running' state, overwriting any previous entry.
   * Emits 'line' on the returned record's signal when lines are appended.
   */
  start(releaseId: number, repo: string): DeployRecord {
    const record: DeployRecord = {
      releaseId,
      repo,
      status: 'running',
      startedAt: new Date(),
      log: [],
      signal: new EventEmitter(),
    };
    record.signal.setMaxListeners(100);
    this.records.set(releaseId, record);
    this.persist(record);
    return record;
  }

  appendLine(record: DeployRecord, line: string): void {
    record.log.push(line);
    record.signal.emit('line', line);
    this.persist(record);
  }

  finish(record: DeployRecord, exitCode: number): void {
    const terminal = `EXIT:${exitCode}`;
    record.log.push(terminal);
    record.signal.emit('line', terminal);
    record.status = exitCode === 0 ? 'completed' : 'failed';
    record.completedAt = new Date();
    this.persist(record);
    record.signal.emit('done');
  }

  isRunning(releaseId: number): boolean {
    return this.records.get(releaseId)?.status === 'running';
  }
}
