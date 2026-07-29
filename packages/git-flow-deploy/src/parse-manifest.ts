import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { DeployManifest } from './types.js';

function validateSharedStorageEntry(entry: unknown, index: number): string {
  if (typeof entry !== 'string') {
    throw new Error(`sharedStorage[${index}] must be a string`);
  }
  if (entry.startsWith('/')) {
    throw new Error(`sharedStorage[${index}] must be a relative path: ${entry}`);
  }
  if (entry.split('/').includes('..')) {
    throw new Error(`sharedStorage[${index}] must not contain '..': ${entry}`);
  }
  return entry;
}

/**
 * Parse and validate a deploy.yml manifest file.
 */
export async function parseDeployYml(path: string): Promise<DeployManifest> {
  const content = await readFile(path, 'utf-8');
  const raw = parse(content) as Record<string, unknown>;

  const requiredFields = ['name', 'version', 'repo', 'releaseId', 'deployCommand'] as const;
  for (const field of requiredFields) {
    if (raw[field] === undefined || raw[field] === null || raw[field] === '') {
      throw new Error(`deploy.yml missing required field: ${field}`);
    }
  }

  const manifest: DeployManifest = {
    name: String(raw['name']),
    version: String(raw['version']),
    repo: String(raw['repo']),
    releaseId: Number(raw['releaseId']),
    deployCommand: String(raw['deployCommand']),
  };

  if (isNaN(manifest.releaseId) || manifest.releaseId <= 0) {
    throw new Error(`deploy.yml releaseId must be a positive integer`);
  }

  if (raw['method'] !== undefined && raw['method'] !== null && raw['method'] !== '') {
    manifest.method = String(raw['method']);
  }
  if (raw['slot'] !== undefined && raw['slot'] !== null && raw['slot'] !== '') {
    manifest.slot = String(raw['slot']);
  }
  if (raw['versioning'] === 'singleton' || raw['versioning'] === 'major') {
    manifest.versioning = raw['versioning'];
  }
  if (
    raw['teardownCommand'] !== undefined &&
    raw['teardownCommand'] !== null &&
    raw['teardownCommand'] !== ''
  ) {
    manifest.teardownCommand = String(raw['teardownCommand']);
  }

  if (raw['sharedStorage'] !== undefined) {
    if (raw['sharedStorage'] === true) {
      manifest.sharedStorage = true;
    } else if (Array.isArray(raw['sharedStorage'])) {
      manifest.sharedStorage = (raw['sharedStorage'] as unknown[]).map(validateSharedStorageEntry);
    } else {
      throw new Error(`deploy.yml sharedStorage must be true or an array of strings`);
    }
  }

  return manifest;
}
