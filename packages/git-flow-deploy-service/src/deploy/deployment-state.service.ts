import { Injectable } from '@nestjs/common';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from './config.service.js';

/**
 * Durable per-slot deployment state.
 *
 * Records which deploy method/version is currently running for a slot and keeps
 * a copy of that slot's extracted bundle under `<stateDir>/<slot>/current/`, so
 * a later mode change can tear the old mode down using the old bundle's own
 * files (docker-compose.yml, ecosystem.config.js, …) even after the volatile
 * /tmp working dir is gone.
 */
export interface DeploymentState {
  /** Deployment slot (identity key). */
  slot: string;
  /** Package name (e.g. '@org/svc'). */
  name: string;
  /** Deploy method currently running ('node' | 'compose' | 'swarm' | …). */
  method: string;
  /** Version currently running. */
  version: string;
  /** GitHub release id currently running. */
  releaseId: number;
  /** Versioning strategy used to derive the slot. */
  versioning?: 'singleton' | 'major';
  /** Absolute path to the saved copy of the running bundle. */
  bundleDir: string;
  /** Command that tears this running mode down (run from bundleDir). */
  teardownCommand?: string;
  /** The deploy command that brought this mode up (used for rollback). */
  deployCommand: string;
  /** ISO timestamp of the last successful save. */
  updatedAt: string;
}

/** Fields the caller supplies; bundleDir + updatedAt are filled by save(). */
export type DeploymentStateInput = Omit<
  DeploymentState,
  'bundleDir' | 'updatedAt'
>;

@Injectable()
export class DeploymentStateService {
  constructor(private readonly config: ConfigService) {}

  private slotDir(slot: string): string {
    return join(this.config.stateDir, slot);
  }
  private statePath(slot: string): string {
    return join(this.slotDir(slot), 'state.json');
  }
  private currentDir(slot: string): string {
    return join(this.slotDir(slot), 'current');
  }

  /** Read the current deployment state for a slot, or undefined if none. */
  get(slot: string): DeploymentState | undefined {
    try {
      const path = this.statePath(slot);
      if (!existsSync(path)) return undefined;
      return JSON.parse(readFileSync(path, 'utf-8')) as DeploymentState;
    } catch {
      return undefined;
    }
  }

  /**
   * Persist state for a slot and take a fresh copy of the extracted bundle.
   * The bundle is copied to a temp sibling then swapped into `current/` so a
   * crash mid-copy never corrupts the retained bundle.
   */
  save(input: DeploymentStateInput, extractedDir: string): DeploymentState {
    const slotDir = this.slotDir(input.slot);
    mkdirSync(slotDir, { recursive: true });

    const current = this.currentDir(input.slot);
    const next = join(slotDir, '.next');

    rmSync(next, { recursive: true, force: true });
    cpSync(extractedDir, next, { recursive: true });
    rmSync(current, { recursive: true, force: true });
    renameSync(next, current);

    const state: DeploymentState = {
      ...input,
      bundleDir: current,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(this.statePath(input.slot), JSON.stringify(state, null, 2));
    return state;
  }

  /** Remove all persisted state (and saved bundle) for a slot. */
  clear(slot: string): void {
    try {
      rmSync(this.slotDir(slot), { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }

  /** Absolute path to the saved "current" bundle dir for a slot. */
  currentBundleDir(slot: string): string {
    return this.currentDir(slot);
  }

  /** Absolute path to the slot's committed state.json. */
  stateFile(slot: string): string {
    return this.statePath(slot);
  }

  /**
   * Stage the post-success state for a self mode-change: write `state.new.json`
   * (with bundleDir pointing at the eventual `current/` dir) which the detached
   * supervisor commits (mv → state.json) only once the new mode has started.
   * Returns the path to the staged file.
   */
  stageState(input: DeploymentStateInput): string {
    const slotDir = this.slotDir(input.slot);
    mkdirSync(slotDir, { recursive: true });
    const state: DeploymentState = {
      ...input,
      bundleDir: this.currentDir(input.slot),
      updatedAt: new Date().toISOString(),
    };
    const file = join(slotDir, 'state.new.json');
    writeFileSync(file, JSON.stringify(state, null, 2));
    return file;
  }
}
