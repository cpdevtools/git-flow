import { downloadBundle } from './download.js';
import { handleCompose } from './methods/compose.js';
import { handleNode } from './methods/node.js';
import { handleSwarm } from './methods/swarm.js';

const PACKAGE_NAME = '@cpdevtools/git-flow-deploy-service';
const VALID_METHODS = ['node', 'compose', 'swarm'] as const;
type Method = (typeof VALID_METHODS)[number];

function parseArgs(): {
  method?: string;
  version?: string;
  latest: boolean;
  token?: string;
  repo: string;
  'install-dir'?: string;
  'npm-prefix'?: string;
  'hmac-secret'?: string;
  'port'?: string;
  'host'?: string;
  'enable-boot': boolean;
} {
  const argv = process.argv.slice(2);
  const result: Record<string, string | boolean> = { latest: false, repo: 'cpdevtools/git-flow', 'enable-boot': false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--latest') {
      result['latest'] = true;
    } else if (arg === '--enable-boot') {
      result['enable-boot'] = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      result[key] = argv[++i] ?? '';
    }
  }

  return result as { method?: string; version?: string; latest: boolean; token?: string; repo: string; 'install-dir'?: string; 'npm-prefix'?: string; 'hmac-secret'?: string; 'port'?: string; 'host'?: string; 'enable-boot': boolean };
}

async function resolveLatestVersion(owner: string, repo: string, token: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=50`, {
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
    draft: boolean;
    prerelease: boolean;
    created_at: string;
  }>;

  const pkgReleases = releases
    .filter(r => !r.draft && !r.prerelease && r.tag_name.endsWith(`/${PACKAGE_NAME}`))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (pkgReleases.length === 0) {
    throw new Error(`No published release found for ${PACKAGE_NAME}`);
  }

  const match = pkgReleases[0].tag_name.match(/^v([^/]+)\//);
  if (!match) throw new Error(`Unexpected tag format: ${pkgReleases[0].tag_name}`);
  return match[1];
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!args.method || !(VALID_METHODS as readonly string[]).includes(args.method)) {
    console.error(
      `Usage: gitflow-deploy-service --method <${VALID_METHODS.join('|')}> [--version <v> | --latest] [--token <token>] [--repo <owner/repo>]\n`,
    );
    console.error(
      '  --method   Deploy method: node (npm+pm2), compose (docker compose), swarm (docker stack)',
    );
    console.error('  --version  Specific version to install (e.g. 1.2.3)');
    console.error('  --latest   Resolve and install the latest published release');
    console.error('  --token        GitHub token (default: GITHUB_TOKEN env var)');
    console.error('  --repo         GitHub repo (default: cpdevtools/git-flow)');
    console.error('  --install-dir  Override install directory (default: ~/git-flow-deploy-service)');
    console.error('  --npm-prefix   Custom npm prefix for global install (default: ~/.npm-global)');
    console.error('  --hmac-secret  HMAC secret for webhook validation (required for first-time node setup)');
    console.error('  --port         Service port (default: 3700)');
    console.error('  --host         Bind address (default: 0.0.0.0)');
    console.error('  --enable-boot  Configure pm2 to start on system boot (runs one sudo step; node method only)');
    process.exit(1);
  }

  const method = args.method as Method;
  const token = args.token ?? process.env['GITHUB_TOKEN'] ?? '';

  if (!token) {
    console.error(
      'Error: --token or GITHUB_TOKEN env var required (used to download the release bundle)',
    );
    process.exit(1);
  }

  const [owner, repoName] = args.repo.split('/');

  if (!owner || !repoName) {
    console.error(`Error: --repo must be in owner/repo format, got: ${args.repo}`);
    process.exit(1);
  }

  let version: string;
  if (args.latest) {
    console.log('Resolving latest version...');
    version = await resolveLatestVersion(owner, repoName, token);
    console.log(`Latest version: ${version}`);
  } else if (args.version) {
    version = args.version;
  } else {
    console.error('Error: one of --version <v> or --latest is required');
    process.exit(1);
  }

  const installDir = args['install-dir'];
  const npmPrefix = args['npm-prefix'];
  const hmacSecret = args['hmac-secret'];
  const port = args['port'];
  const host = args['host'];
  const enableBoot = args['enable-boot'];

  console.log(`\nDeploying ${PACKAGE_NAME} v${version} (method: ${method}) from ${owner}/${repoName}...\n`);

  const extractDir = await downloadBundle({ method, version, owner, repo: repoName, token, installDir });

  switch (method) {
    case 'node':
      await handleNode({ extractDir, version, token, npmPrefix, hmacSecret, port, host, enableBoot });
      break;
    case 'compose':
      await handleCompose({ extractDir });
      break;
    case 'swarm':
      await handleSwarm({ extractDir });
      break;
  }

  console.log('\n✅ Done!');
}

main().catch(err => {
  console.error('\n❌', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
