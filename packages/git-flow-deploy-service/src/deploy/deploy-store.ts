import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { DeployRecord, DeployStatus } from './deploy-record.js';

@Injectable()
export class DeployStore {
  private readonly records = new Map<number, DeployRecord>();

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
    // Allow many log-stream watchers without Node warning
    record.signal.setMaxListeners(100);
    this.records.set(releaseId, record);
    return record;
  }

  appendLine(record: DeployRecord, line: string): void {
    record.log.push(line);
    record.signal.emit('line', line);
  }

  finish(record: DeployRecord, exitCode: number): void {
    const terminal = `EXIT:${exitCode}`;
    this.appendLine(record, terminal);
    record.status = exitCode === 0 ? 'completed' : 'failed';
    record.completedAt = new Date();
    record.signal.emit('done');
  }

  isRunning(releaseId: number): boolean {
    return this.records.get(releaseId)?.status === 'running';
  }
}
