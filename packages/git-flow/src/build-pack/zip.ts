/**
 * Zip a directory with adm-zip rather than the `zip` CLI, which Windows runners
 * (and Git Bash) do not ship. Entries are stored relative to `dir`, so the
 * archive extracts to the same layout `zip -r <out> .` produced.
 */

import AdmZip from 'adm-zip';
import { rm } from 'node:fs/promises';

export async function zipDirectory(dir: string, zipPath: string): Promise<void> {
  // Always start from nothing: an existing archive must not keep entries from
  // an earlier run that are no longer in the directory.
  await rm(zipPath, { force: true });
  const zip = new AdmZip();
  zip.addLocalFolder(dir);
  await zip.writeZipPromise(zipPath);
}
