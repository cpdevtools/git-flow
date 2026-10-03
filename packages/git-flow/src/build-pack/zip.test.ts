import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipDirectory } from './zip.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zip-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('zipDirectory', () => {
  it('stores entries relative to the directory, like `zip -r out .`', async () => {
    const src = join(dir, 'bundle');
    await mkdir(join(src, 'sub', 'deeper'), { recursive: true });
    await writeFile(join(src, 'deploy.yml'), 'deployCommand: true\n');
    await writeFile(join(src, 'sub', 'deeper', 'x.txt'), 'x');
    const out = join(dir, 'out.zip');

    await zipDirectory(src, out);

    const names = new AdmZip(out)
      .getEntries()
      .filter((e) => !e.isDirectory)
      .map((e) => e.entryName)
      .sort();
    expect(names).toEqual(['deploy.yml', 'sub/deeper/x.txt']);
    expect(new AdmZip(out).readAsText('deploy.yml')).toBe('deployCommand: true\n');
  });

  it('replaces an existing archive instead of updating it', async () => {
    const src = join(dir, 'bundle');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'old.txt'), 'old');
    const out = join(dir, 'out.zip');
    await zipDirectory(src, out);

    await rm(join(src, 'old.txt'));
    await writeFile(join(src, 'new.txt'), 'new');
    await zipDirectory(src, out);

    const names = new AdmZip(out).getEntries().map((e) => e.entryName);
    expect(names).toEqual(['new.txt']);
  });
});
