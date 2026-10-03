import AdmZip from 'adm-zip';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseDeployYml } from './parse-manifest.js';
import type { DeployManifest } from './types.js';

/**
 * Withdrawal kinds that may still be deployed with `--force` (rollbacks).
 * Mirrors KIND_INFO in @cpdevtools/git-flow/withdraw; this package does not
 * depend on the library, so the list is repeated here on purpose.
 */
export const FORCEABLE_WITHDRAW_KINDS: readonly string[] = ['obsolete', 'superseded', 'temporary'];

export interface ReleaseWithdrawal {
  kind: string;
  reason: string;
  replacedBy?: string;
}

export class WithdrawnReleaseError extends Error {
  constructor(
    public readonly releaseId: number,
    public readonly withdrawal: ReleaseWithdrawal,
    public readonly forceable: boolean,
  ) {
    super(
      `Release ${releaseId} is WITHDRAWN (${withdrawal.kind}): ${withdrawal.reason}` +
        (withdrawal.replacedBy ? ` — use ${withdrawal.replacedBy} instead` : '') +
        (forceable ? '. Pass --force to deploy it anyway.' : '. This kind can never be forced.'),
    );
    this.name = 'WithdrawnReleaseError';
  }
}

/** The withdrawal marker in a release body's Artifact Metadata block, if any. */
export function readReleaseWithdrawal(body: string | null | undefined): ReleaseWithdrawal | undefined {
  const m = body?.match(/## Artifact Metadata\s*```yaml\s*\n([\s\S]*?)\n\s*```/m);
  if (!m) return undefined;
  try {
    const parsed = parseYaml(m[1]!) as { withdrawn?: Partial<ReleaseWithdrawal> } | null;
    const w = parsed?.withdrawn;
    if (w && typeof w.kind === 'string') {
      return { kind: w.kind, reason: w.reason ?? '', replacedBy: w.replacedBy };
    }
  } catch {
    // malformed metadata: not withdrawn
  }
  return undefined;
}

export interface FetchDeployBundleOptions {
  /** Deploy a withdrawn release anyway, when its kind allows it. */
  force?: boolean;
}

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
  assetName = 'deploy.zip',
  options: FetchDeployBundleOptions = {},
): Promise<DeployManifest> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // A withdrawn release is refused before a single byte is fetched.
  const releaseRes = await fetch(`https://api.github.com/repos/${repo}/releases/${releaseId}`, {
    headers,
  });
  if (!releaseRes.ok) {
    throw new Error(
      `Failed to read release ${releaseId}: ${releaseRes.status} ${releaseRes.statusText}`,
    );
  }
  const release = (await releaseRes.json()) as { body?: string | null };
  const withdrawal = readReleaseWithdrawal(release.body);
  if (withdrawal) {
    const forceable = FORCEABLE_WITHDRAW_KINDS.includes(withdrawal.kind);
    if (!(options.force && forceable)) {
      throw new WithdrawnReleaseError(releaseId, withdrawal, forceable);
    }
  }

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
  const deployAsset = assets.find((a) => a.name === assetName);

  if (!deployAsset) {
    throw new Error(`No ${assetName} asset found in release ${releaseId} of ${repo}`);
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
