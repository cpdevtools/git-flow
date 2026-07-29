import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function readSecret(name: string): string | undefined {
  const envVal = process.env[name];
  if (envVal) return envVal;
  try {
    return readFileSync(`/run/secrets/${name}`, 'utf-8').trim();
  } catch {
    return undefined;
  }
}

function requireSecret(name: string): string {
  const value = readSecret(name);
  if (!value) throw new Error(`Required secret/env "${name}" is not set`);
  return value;
}

@Injectable()
export class ConfigService {
  readonly hmacSecret: string = requireSecret('DEPLOY_HMAC_SECRET');
  readonly githubToken: string = requireSecret('GITHUB_TOKEN');
  readonly workDir: string = process.env['DEPLOY_WORK_DIR'] ?? '/tmp/deployments';
  readonly sharedStorageBaseDir: string | undefined = process.env['SHARED_STORAGE_BASE_DIR'];
  /**
   * Durable directory for per-slot deployment state + a saved copy of each
   * slot's currently-running bundle (used to tear down the old mode on a mode
   * change). Defaults under the home dir — NOT the volatile workDir (/tmp).
   */
  readonly stateDir: string =
    process.env['DEPLOY_STATE_DIR'] ?? join(homedir(), '.git-flow-deploy-service', 'state');
}
