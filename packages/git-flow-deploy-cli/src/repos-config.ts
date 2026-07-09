import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const REPOS_CONFIG_PATH = process.env['DEPLOY_REPOS_CONFIG'] ?? '/etc/deploy-gateway/repos.json';

export interface ReposConfig {
  allow: string[];
  deny: string[];
}

export async function readReposConfig(): Promise<ReposConfig> {
  try {
    const raw = await readFile(REPOS_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ReposConfig>;
    return {
      allow: Array.isArray(parsed.allow) ? parsed.allow : [],
      deny: Array.isArray(parsed.deny) ? parsed.deny : [],
    };
  } catch {
    return { allow: [], deny: [] };
  }
}

export async function writeReposConfig(config: ReposConfig): Promise<void> {
  await mkdir(dirname(REPOS_CONFIG_PATH), { recursive: true });
  await writeFile(REPOS_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
