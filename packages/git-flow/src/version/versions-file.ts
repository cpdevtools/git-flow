import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const CANDIDATES = ['.publish/versions.yml', '.github/versions.yml'];

export async function findVersionsFile(cwd?: string): Promise<string | null> {
  const base = cwd ?? process.cwd();
  for (const c of CANDIDATES) {
    const full = join(base, c);
    if (existsSync(full)) return full;
  }
  return null;
}

export async function readVersionsFile(path: string): Promise<Record<string, string>> {
  const content = await readFile(path, 'utf-8');
  return parseYaml(content) as Record<string, string>;
}

export async function writeVersionsFile(
  path: string,
  versions: Record<string, string>,
): Promise<void> {
  const content = stringifyYaml(versions);
  await writeFile(path, content, 'utf-8');
}
