import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cached: { name: string; version: string } | undefined;

/**
 * Read this service's name and version from its own package.json.
 * Resolved relative to the compiled file location and cached after first read.
 */
export function getServiceInfo(): { name: string; version: string } {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as {
      name?: string;
      version?: string;
    };
    cached = { name: pkg.name ?? 'unknown', version: pkg.version ?? '0.0.0' };
  } catch {
    cached = { name: 'unknown', version: '0.0.0' };
  }
  return cached;
}
