import AdmZip from 'adm-zip';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDeployYml } from './parse-manifest.js';
import type { DeployManifest } from './types.js';

interface GitHubAsset {
  name: string;
  url: string;
}

/**
 * Download `deploy.zip` from a GitHub Release, extract it to `destDir`,
 * validate that `deploy.yml` is present, and return the parsed manifest.
 */
export async function fetchDeployBundle(
  token: string,
  repo: string,
  releaseId: number,
  destDir: string,
): Promise<DeployManifest> {
  // List release assets
  const assetsUrl = `https://api.github.com/repos/${repo}/releases/${releaseId}/assets`;
  const assetsRes = await fetch(assetsUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!assetsRes.ok) {
    throw new Error(
      `Failed to list assets for release ${releaseId}: ${assetsRes.status} ${assetsRes.statusText}`,
    );
  }

  const assets = (await assetsRes.json()) as GitHubAsset[];
  const deployAsset = assets.find((a) => a.name === 'deploy.zip');

  if (!deployAsset) {
    throw new Error(`No deploy.zip asset found in release ${releaseId} of ${repo}`);
  }

  // Download via the asset API URL (requires Accept: application/octet-stream)
  const downloadRes = await fetch(deployAsset.url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/octet-stream',
    },
    redirect: 'follow',
  });

  if (!downloadRes.ok) {
    throw new Error(
      `Failed to download deploy.zip from release ${releaseId}: ${downloadRes.status} ${downloadRes.statusText}`,
    );
  }

  await mkdir(destDir, { recursive: true });

  const buffer = Buffer.from(await downloadRes.arrayBuffer());
  const zip = new AdmZip(buffer);
  zip.extractAllTo(destDir, /* overwrite */ true);

  // Validate that deploy.yml is present
  const manifestPath = join(destDir, 'deploy.yml');
  try {
    await access(manifestPath);
  } catch {
    throw new Error(`deploy.zip extracted to ${destDir} but deploy.yml is missing`);
  }

  return parseDeployYml(manifestPath);
}
