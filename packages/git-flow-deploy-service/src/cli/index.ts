import { downloadBundle } from './download.js';
import { handleCompose } from './methods/compose.js';
import { handleNode } from './methods/node.js';
import { handleSwarm } from './methods/swarm.js';
import { recordInitialState } from './record-initial-state.js';
import { runSupervisor } from '../supervisor/supervise.js';

const PACKAGE_NAME = '@cpdevtools/git-flow-deploy-service';
const VALID_METHODS = ['node', 'compose', 'swarm'] as const;
type Method = (typeof VALID_METHODS)[number];

interface CliArgs {
  method?: string;
  version?: string;
  latest: boolean;
  next: boolean;
  token?: string;
  repo: string;
  'install-dir'?: string;
  'npm-prefix'?: string;
  'hmac-secret'?: string;
  'compose-file'?: string;
  'port'?: string;
  'host'?: string;
  'enable-boot': boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const result: Record<string, string | boolean> = {
    latest: false,
    next: false,
    repo: 'cpdevtools/git-flow',
    'enable-boot': false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--latest') {
      result['latest'] = true;
    } else if (arg === '--next') {
      result['next'] = true;
    } else if (arg === '--enable-boot') {
      result['enable-boot'] = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      result[key] = argv[++i] ?? '';
    }
  }

  return result as unknown as CliArgs;
}

/**
 * Newest published release of this package.
 * @param includePrereleases include `-dev.N` / `-rc.N` builds (the `--next` channel).
 */
async function resolveLatestVersion(
  owner: string,
  repo: string,
  token: string,
  includePrereleases = false,
): Promise<string> {
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
    .filter(
      r => !r.draft && (includePrereleases || !r.prerelease) && r.tag_name.endsWith(`/${PACKAGE_NAME}`),
    )
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (pkgReleases.length === 0) {
    throw new Error(
      `No ${includePrereleases ? '' : 'stable '}release found for ${PACKAGE_NAME}` +
        (includePrereleases ? '' : ' — use --next to include prereleases'),
    );
  }

  const match = pkgReleases[0].tag_name.match(/^v([^/]+)\//);
  if (!match) throw new Error(`Unexpected tag format: ${pkgReleases[0].tag_name}`);
  return match[1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Internal subcommand: drive a self-replacing deploy on behalf of a running
  // service that cannot survive its own deploy command. See ../supervisor/.
  if (argv[0] === 'supervise') {
    const planPath = argv[argv.indexOf('--plan') + 1];
    if (!argv.includes('--plan') || !planPath) {
      console.error('Usage: gitflow-deploy-service supervise --plan <plan.json>');
      process.exit(1);
    }
    process.exit(await runSupervisor(planPath));
  }

  const args = parseArgs(argv);

  if (!args.method || !(VALID_METHODS as readonly string[]).includes(args.method)) {
    console.error(
      `Usage: gitflow-deploy-service --method <${VALID_METHODS.join('|')}> [--version <v> | --latest | --next] [--token <token>] [--repo <owner/repo>]\n`,
    );
    console.error(
      '  --method   Deploy method: node (npm+pm2), compose (docker compose), swarm (docker stack)',
    );
    console.error('  --version  Specific version to install (e.g. 1.2.3)');
    console.error('  --latest   Resolve and install the latest stable release');
    console.error('  --next     Resolve and install the latest release including prereleases');
    console.error('  --token        GitHub token (default: GITHUB_TOKEN env var)');
    console.error('  --repo         GitHub repo (default: cpdevtools/git-flow)');
    console.error('  --install-dir  Override install directory (default: ~/git-flow-deploy-service)');
    console.error('  --npm-prefix   Custom npm prefix for global install (default: ~/.npm-global)');
    console.error('  --hmac-secret  HMAC secret for webhook validation (required for first-time node setup)');
    console.error('  --compose-file Compose file within the bundle (default: $COMPOSE_FILE or docker-compose.yml)');
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
  if (args.latest || args.next) {
    console.log(`Resolving latest ${args.next ? 'release (including prereleases)' : 'stable release'}...`);
    version = await resolveLatestVersion(owner, repoName, token, args.next);
    console.log(`Resolved version: ${version}`);
  } else if (args.version) {
    version = args.version;
  } else {
    console.error('Error: one of --version <v>, --latest or --next is required');
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
      await handleCompose({ extractDir, token, hmacSecret, composeFile: args['compose-file'] });
      break;
    case 'swarm':
      await handleSwarm({ extractDir });
      break;
  }

  // Record the provisioned mode so a later mode-change deploy can tear it down.
  await recordInitialState(extractDir);

  console.log('\n✅ Done!');
}

main().catch(err => {
  console.error('\n❌', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
