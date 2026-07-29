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
  /**
   * For a self-update, the version being deployed. Persisted so the restarted
   * service can confirm on boot that it is running the target version and
   * finalize the deploy itself — even if the restart supervisor was killed by
   * pm2 before it could append the terminal EXIT line.
   */
  targetVersion?: string;
  /** Internal: active tail poller handle while awaiting an external EXIT. */
  tailTimer?: NodeJS.Timeout;
}
