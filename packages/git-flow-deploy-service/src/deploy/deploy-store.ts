import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DeployRecord, DeployStatus } from './deploy-record.js';
import { getServiceInfo } from '../version.js';

/**
 * Persisted per-release metadata. The log lines themselves live in the
 * append-only `deploy.log` (see logPath) — NOT in this file — so the log
 * survives a self-update restart and can be appended to by the bundle's
 * restart supervisor while the service is down.
 */
interface PersistedMeta {
  releaseId: number;
  repo: string;
  status: DeployStatus;
  startedAt: string;
  completedAt?: string;
  selfUpdate?: boolean;
  targetVersion?: string;
}

/** Poll interval for tailing deploy.log for externally-appended lines. */
const TAIL_POLL_MS = 500;
/**
 * Safety net: if a self-update's restart supervisor never appends a terminal
 * EXIT line (e.g. it crashed), finalize the record as failed after this long so
 * the record never stays 'running' forever.
 */
const TAIL_MAX_WAIT_MS = 5 * 60_000;

@Injectable()
export class DeployStore implements OnModuleInit {
  private readonly records = new Map<number, DeployRecord>();
  // Must match ConfigService.workDir so boot-restore reads the same durable
  // deploy.log the running service wrote (shared across methods via bind mount).
  private readonly workDir: string =
    process.env['DEPLOY_WORK_DIR'] ??
    join(homedir(), '.git-flow-deploy-service', 'work');

  onModuleInit(): void {
    this.loadPersistedRecords();
  }

  private releaseDir(releaseId: number): string {
    return join(this.workDir, String(releaseId));
  }

  private metaPath(releaseId: number): string {
    return join(this.releaseDir(releaseId), 'deploy-record.json');
  }

  /** Append-only log file — the single reconnectable source of truth. */
  private logPath(releaseId: number): string {
    return join(this.releaseDir(releaseId), 'deploy.log');
  }

  /** Write metadata only (status/times/flags). Log lines go to deploy.log. */
  private persistMeta(record: DeployRecord): void {
    try {
      mkdirSync(this.releaseDir(record.releaseId), { recursive: true });
      const data: PersistedMeta = {
        releaseId: record.releaseId,
        repo: record.repo,
        status: record.status,
        startedAt: record.startedAt.toISOString(),
        completedAt: record.completedAt?.toISOString(),
        selfUpdate: record.selfUpdate,
        targetVersion: record.targetVersion,
      };
      writeFileSync(this.metaPath(record.releaseId), JSON.stringify(data));
    } catch {
      // Best-effort — don't crash on persist failure
    }
  }

  /** Append a single line to the durable deploy.log. */
  private appendToFile(releaseId: number, line: string): void {
    try {
      appendFileSync(this.logPath(releaseId), line + '\n');
    } catch {
      // Best-effort
    }
  }

  private loadPersistedRecords(): void {
    try {
      if (!existsSync(this.workDir)) return;
      for (const entry of readdirSync(this.workDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const releaseId = Number(entry.name);
        if (!Number.isInteger(releaseId)) continue;
        const metaFile = this.metaPath(releaseId);
        if (!existsSync(metaFile)) continue;
        try {
          this.restoreRecord(releaseId, metaFile);
        } catch {
          // Skip malformed record
        }
      }
    } catch {
      // Best-effort
    }
  }

  private restoreRecord(releaseId: number, metaFile: string): void {
    const meta: PersistedMeta = JSON.parse(readFileSync(metaFile, 'utf-8'));

    const logFile = this.logPath(releaseId);
    const lines = existsSync(logFile)
      ? readFileSync(logFile, 'utf-8').split('\n').slice(0, -1) // drop trailing '' after final \n
      : [];

    const record: DeployRecord = {
      releaseId: meta.releaseId,
      repo: meta.repo,
      status: meta.status,
      startedAt: new Date(meta.startedAt),
      completedAt: meta.completedAt ? new Date(meta.completedAt) : undefined,
      log: lines,
      signal: new EventEmitter(),
      selfUpdate: meta.selfUpdate,
      targetVersion: meta.targetVersion,
    };
    record.signal.setMaxListeners(100);
    this.records.set(releaseId, record);

    const exitLine = lines.find((l) => l.startsWith('EXIT:'));
    if (exitLine) {
      // Supervisor (or a prior run) already finalized in the log — reconcile status.
      const code = parseInt(exitLine.slice(5), 10);
      record.status = code === 0 ? 'completed' : 'failed';
      if (!record.completedAt) record.completedAt = new Date();
      return;
    }

    if (meta.status !== 'running') return;

    if (meta.selfUpdate) {
      // A self-update was in flight when we died. If THIS restored instance is
      // already running the target version, the update demonstrably succeeded
      // (the newly-installed code is what just booted) — finalize immediately
      // instead of waiting on the restart supervisor, which pm2 may have killed
      // before it could append the terminal EXIT line.
      const running = getServiceInfo().version;
      if (record.targetVersion && running === record.targetVersion) {
        this.appendLine(
          record,
          `\u2713 Restart verified on boot: service is running v${running}.`,
        );
        this.finish(record, 0);
      } else {
        // Version unknown or not yet the target — fall back to tailing deploy.log
        // for the supervisor's health-verify output and its terminal EXIT.
        this.startTail(record);
      }
    } else {
      // A non-self-update deploy was interrupted by an unexpected restart/crash.
      // We cannot know it succeeded — record a failure rather than a false success.
      this.appendLine(
        record,
        '\u25b8 Service restarted unexpectedly during deploy — marking failed',
      );
      this.finish(record, 1);
    }
  }

  get(releaseId: number): DeployRecord | undefined {
    return this.records.get(releaseId);
  }

  /**
   * Create a new record in 'running' state, overwriting any previous entry.
   * Truncates any previous deploy.log for this release. Emits 'line' on the
   * returned record's signal when lines are appended.
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
    try {
      mkdirSync(this.releaseDir(releaseId), { recursive: true });
      writeFileSync(this.logPath(releaseId), ''); // fresh log for this run
    } catch {
      // Best-effort
    }
    this.persistMeta(record);
    return record;
  }

  /**
   * Mark a record as a self-update (updating the deploy-service itself). Such a
   * deploy hands completion off to the bundle's restart supervisor.
   */
  setSelfUpdate(record: DeployRecord, targetVersion?: string): void {
    record.selfUpdate = true;
    if (targetVersion) record.targetVersion = targetVersion;
    this.persistMeta(record);
  }

  appendLine(record: DeployRecord, line: string): void {
    record.log.push(line);
    this.appendToFile(record.releaseId, line);
    // Mirror deploy output to the service's own stdout so `pm2 logs` shows it.
    process.stdout.write(`[deploy ${record.releaseId}] ${line}\n`);
    record.signal.emit('line', line);
  }

  finish(record: DeployRecord, exitCode: number): void {
    this.stopTail(record);
    const terminal = `EXIT:${exitCode}`;
    record.log.push(terminal);
    this.appendToFile(record.releaseId, terminal);
    record.signal.emit('line', terminal);
    record.status = exitCode === 0 ? 'completed' : 'failed';
    record.completedAt = new Date();
    this.persistMeta(record);
    record.signal.emit('done');
  }

  /**
   * Begin tailing deploy.log for lines appended by an external writer (the
   * restart supervisor) while/after the service restarts. Emits each new line on
   * the record's signal and finalizes the record when a terminal EXIT appears.
   *
   * Safe to call on the record's own service instance (it will be killed by the
   * restart) and again on the restarted instance during boot — only the surviving
   * instance's timer matters.
   */
  startTail(record: DeployRecord): void {
    if (record.tailTimer) return;
    // Lines already in record.log (loaded from disk / appended pre-handoff) are
    // the baseline; the tailer only emits lines appended beyond that point.
    let emitted = record.log.length;
    const startedAt = Date.now();

    record.tailTimer = setInterval(() => {
      let complete: string[];
      try {
        // Re-read complete lines (byte/char-safe). An unterminated trailing line
        // (no final '\n' yet) is excluded until the writer completes it.
        const content = readFileSync(this.logPath(record.releaseId), 'utf-8');
        complete = content.split('\n').slice(0, -1);
      } catch {
        return; // transient (e.g. file briefly gone during restart) — retry next tick
      }

      if (complete.length < emitted) {
        // Log was truncated/rotated (e.g. a fresh deploy started) — stop tailing.
        this.stopTail(record);
        return;
      }

      if (complete.length === emitted) {
        if (Date.now() - startedAt > TAIL_MAX_WAIT_MS) {
          this.appendLine(
            record,
            '\u26a0 Restart supervisor did not report completion within timeout — marking failed',
          );
          this.finish(record, 1);
        }
        return;
      }

      for (; emitted < complete.length; emitted++) {
        const line = complete[emitted];
        record.log.push(line);
        record.signal.emit('line', line);
        if (line.startsWith('EXIT:')) {
          const code = parseInt(line.slice(5), 10);
          this.finalizeFromTail(record, Number.isNaN(code) ? 1 : code);
          return;
        }
      }
    }, TAIL_POLL_MS);

    // Don't keep the event loop alive solely for tailing.
    record.tailTimer.unref?.();
  }

  private stopTail(record: DeployRecord): void {
    if (record.tailTimer) {
      clearInterval(record.tailTimer);
      record.tailTimer = undefined;
    }
  }

  /**
   * Finalize a record whose terminal EXIT was appended externally (via tail).
   * The EXIT line is already in record.log/deploy.log — do not re-append it.
   */
  private finalizeFromTail(record: DeployRecord, exitCode: number): void {
    this.stopTail(record);
    record.status = exitCode === 0 ? 'completed' : 'failed';
    record.completedAt = new Date();
    this.persistMeta(record);
    record.signal.emit('done');
  }

  isRunning(releaseId: number): boolean {
    return this.records.get(releaseId)?.status === 'running';
  }
}
