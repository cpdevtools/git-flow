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
  /**
   * True when this deploy is updating the deploy-service itself. Such a deploy
   * restarts (kills) this process, so completion is handed off to the bundle's
   * restart supervisor, which appends its output and the terminal EXIT line to
   * the shared deploy.log. The (restarted) service tails that file to finish.
   */
  selfUpdate?: boolean;
  /** Internal: active tail poller handle while awaiting an external EXIT. */
  tailTimer?: NodeJS.Timeout;
}
