import { EventEmitter } from 'node:events';

export type DeployStatus = 'running' | 'completed' | 'failed';

export interface DeployRecord {
  releaseId: number;
  repo: string;
  status: DeployStatus;
  startedAt: Date;
  completedAt?: Date;
  /** Append-only log buffer (excludes :hb heartbeats). EXIT:0/EXIT:1 stored as final line. */
  log: string[];
  /** Fires 'line' whenever a new line is appended. */
  signal: EventEmitter;
}
