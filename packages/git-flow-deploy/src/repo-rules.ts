import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { minimatch } from 'minimatch';

export interface ReposConfig {
  allow: string[];
  deny: string[];
}

export const DEFAULT_REPOS_CONFIG_PATH = '/etc/deploy-gateway/repos.json';

export const EMPTY_REPOS_CONFIG: ReposConfig = { allow: [], deny: [] };

export function reposConfigPath(override?: string): string {
  return override ?? process.env['DEPLOY_REPOS_CONFIG'] ?? DEFAULT_REPOS_CONFIG_PATH;
}

/**
 * Authorization rules, in order:
 *   1. matches any deny pattern → denied (deny always wins)
 *   2. allow list non-empty and matches none of it → denied
 *   3. otherwise → permitted (an empty allow list permits anything not denied)
 */
export function isRepoAllowed(repo: string, config: ReposConfig): boolean {
  if (config.deny.some((pattern) => minimatch(repo, pattern))) return false;
  if (config.allow.length > 0) return config.allow.some((pattern) => minimatch(repo, pattern));
  return true;
}

/**
 * Absent file → empty config, since a fresh install has no rules yet. Any other
 * failure throws: a corrupt file must not read as "no rules" and silently permit
 * everything.
 */
export async function readReposConfig(path?: string): Promise<ReposConfig> {
  const file = reposConfigPath(path);
  let raw: string;

  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_REPOS_CONFIG };
    throw err;
  }

  let parsed: Partial<ReposConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<ReposConfig>;
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }

  return {
    allow: Array.isArray(parsed.allow) ? parsed.allow : [],
    deny: Array.isArray(parsed.deny) ? parsed.deny : [],
  };
}

export async function writeReposConfig(config: ReposConfig, path?: string): Promise<void> {
  const file = reposConfigPath(path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
