import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

export interface DownloadOptions {
  method: string;
  version: string;
  owner: string;
  repo: string;
  token: string;
  /** Override the base install directory. Defaults to ~/git-flow-deploy-service */
  installDir?: string;
}

const PACKAGE_NAME = '@cpdevtools/git-flow-deploy-service';
const DEFAULT_INSTALL_BASE = join(homedir(), 'git-flow-deploy-service');

export async function downloadBundle(options: DownloadOptions): Promise<string> {
  const { method, version, owner, repo, token, installDir } = options;
  const assetName = `deploy-${method}.zip`;
  const installBase = installDir ?? DEFAULT_INSTALL_BASE;
  // The method is part of the path: each method ships a DIFFERENT bundle for the
  // same version (deploy-node.zip vs deploy-compose.zip). Keyed on version alone,
  // installing method B after method A would silently reuse A's bundle.
  const extractDir = join(installBase, version, method);

  if (existsSync(join(extractDir, 'deploy.yml'))) {
    console.log(`Bundle already extracted at ${extractDir}, skipping download.`);
    return extractDir;
  }

  // Find the release matching this package + version
  console.log(`Fetching release list from ${owner}/${repo}...`);
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'gitflow-deploy-service-cli',
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to list releases: ${res.status} ${await res.text()}`);
  }

  const releases = (await res.json()) as Array<{
    tag_name: string;
    assets: Array<{ name: string; url: string }>;
  }>;

  const tag = `v${version}/${PACKAGE_NAME}`;
  const release = releases.find(r => r.tag_name === tag);
  if (!release) {
    throw new Error(`Release not found for tag: ${tag}`);
  }

  const asset = release.assets.find(a => a.name === assetName);
  if (!asset) {
    const available = release.assets.map(a => a.name).join(', ');
    throw new Error(
      `Asset "${assetName}" not found in release ${tag}. Available assets: ${available || '(none)'}`,
    );
  }

  // Download the zip asset
  console.log(`Downloading ${assetName}...`);
  const dlRes = await fetch(asset.url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/octet-stream',
      'User-Agent': 'gitflow-deploy-service-cli',
    },
  });
  if (!dlRes.ok) {
    throw new Error(`Failed to download asset: ${dlRes.status} ${await dlRes.text()}`);
  }

  const buf = await dlRes.arrayBuffer();
  const tempDir = mkdtempSync(join(tmpdir(), 'gitflow-deploy-'));
  const zipPath = join(tempDir, assetName);
  writeFileSync(zipPath, Buffer.from(buf));

  // Extract to versioned install directory
  mkdirSync(extractDir, { recursive: true });
  console.log(`Extracting to ${extractDir}...`);
  execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'inherit' });

  return extractDir;
}
