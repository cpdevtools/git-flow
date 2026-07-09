import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';

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
}
