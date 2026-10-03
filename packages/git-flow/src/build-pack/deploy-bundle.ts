/**
 * Zip a project's deploy output dir and upload it to its draft release.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { safeName } from '../artifacts/slot.js';
import type { UploadContext } from '../artifacts/index.js';
import { ARTIFACT_OUTPUT_DIR } from './generate-artifact.js';
import { uploadArtifact } from './github.js';
import { zipDirectory } from './zip.js';

/**
 * Zip `deployOutputDir` and upload it as `deploy-<method>.zip`.
 *
 * Projects are packed concurrently into one shared staging dir and every
 * project publishes the same asset name, so the on-disk name carries the
 * project: with a shared path, two projects' bundles ended up in one archive
 * and both releases got whichever was written last. The published asset name
 * stays `deploy-<method>.zip` — the deploy gateway and CLI look it up by name.
 *
 * @returns the on-disk zip path
 */
export async function uploadDeployBundle(
  projectName: string,
  method: string,
  deployOutputDir: string,
  uploadCtx: UploadContext,
  outputDir: string = ARTIFACT_OUTPUT_DIR,
): Promise<string> {
  const assetName = `deploy-${method}.zip`;
  const zipPath = join(outputDir, `${safeName(projectName)}-${assetName}`);
  await mkdir(outputDir, { recursive: true });
  await zipDirectory(deployOutputDir, zipPath);

  await uploadArtifact(
    uploadCtx.githubToken,
    uploadCtx.owner,
    uploadCtx.repo,
    uploadCtx.releaseId,
    uploadCtx.uploadUrl,
    zipPath,
    assetName,
  );
  return zipPath;
}
