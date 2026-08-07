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

function validateSeedStorageEntry(entry: unknown, index: number): { from: string; to: string } {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`seedStorage[${index}] must be an object with 'from' and 'to'`);
  }
  const { from, to } = entry as { from?: unknown; to?: unknown };
  for (const [key, value] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`seedStorage[${index}].${key} must be a non-empty string`);
    }
    if (value.startsWith('/')) {
      throw new Error(`seedStorage[${index}].${key} must be a relative path: ${value}`);
    }
    if (value.split('/').includes('..')) {
      throw new Error(`seedStorage[${index}].${key} must not contain '..': ${value}`);
    }
  }
  return { from: from as string, to: to as string };
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

  if (raw['seedStorage'] !== undefined) {
    if (!Array.isArray(raw['seedStorage'])) {
      throw new Error(`deploy.yml seedStorage must be an array of { from, to } objects`);
    }
    manifest.seedStorage = (raw['seedStorage'] as unknown[]).map(validateSeedStorageEntry);
  }

  return manifest;
}
