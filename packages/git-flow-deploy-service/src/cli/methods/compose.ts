import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bundleSlot } from '../bundle-slot.js';

/** Host dir holding work/ and state/, bind-mounted into the container. */
export function defaultHostRoot(): string {
  return process.env['DEPLOY_HOST_ROOT'] ?? join(homedir(), '.git-flow-deploy-service');
}

export interface ComposeHandlerOptions {
  extractDir: string;
  /** GitHub token — passed to the container as GITHUB_TOKEN. */
  token: string;
  /** HMAC secret for webhook validation — passed to the container as DEPLOY_HMAC_SECRET. */
  hmacSecret?: string;
  /** Compose file within the bundle. Defaults to $COMPOSE_FILE, then docker-compose.yml. */
  composeFile?: string;
}

export async function handleCompose(options: ComposeHandlerOptions): Promise<void> {
  const { extractDir, token, hmacSecret } = options;
  // Bundles ship variants (e.g. docker-compose.netns.yml) that the operator
  // selects; hardcoding docker-compose.yml made them unreachable from the CLI.
  const composeFile = join(
    extractDir,
    options.composeFile ?? process.env['COMPOSE_FILE'] ?? 'docker-compose.yml',
  );
  // The project name is the deployment slot, matching the `-p <slot>` that the
  // bundle's own deployCommand uses. Without it compose derives the project from
  // the extract-dir basename, so a CLI bootstrap and a later webhook deploy would
  // manage two DIFFERENT stacks — and the service's own container lookup (by the
  // com.docker.compose.project label) would not find it.
  const slot = await bundleSlot(extractDir);
  const base = ['compose', ...(slot ? ['-p', slot] : []), '-f', composeFile];

  const isRunning = isComposeRunning(base);

  if (!isRunning && !hmacSecret) {
    throw new Error(
      '--hmac-secret is required for first-time setup (passed to the container as DEPLOY_HMAC_SECRET)',
    );
  }

  // The compose file resolves DEPLOY_HMAC_SECRET / GITHUB_TOKEN via ${VAR}
  // substitution from the environment running compose. Non-swarm compose cannot
  // use external secrets, so inject them here.
  //
  // DEPLOY_HOST_ROOT is pinned here rather than left as ${HOME} in the compose
  // file: a later self-deploy runs compose from INSIDE the container, where $HOME
  // is /root, which would silently move the work/state bind sources to a fresh
  // empty host dir and break the deploy-log handoff. The compose file passes this
  // value into the container so every subsequent generation reuses it.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_TOKEN: token,
    DEPLOY_HOST_ROOT: defaultHostRoot(),
    ...(hmacSecret ? { DEPLOY_HMAC_SECRET: hmacSecret } : {}),
  };

  if (!isRunning) {
    console.log(`Starting service with docker compose (first-time, project: ${slot ?? 'default'})...`);
  } else {
    console.log('Existing docker compose service detected — pulling and restarting...');
    docker([...base, 'pull'], env);
  }
  docker([...base, 'up', '-d', '--force-recreate', '--remove-orphans'], env);

  console.log('docker compose deployment complete ✓');
}

/** Run docker with an argv array — no shell, so no value needs quoting. */
function docker(args: string[], env: NodeJS.ProcessEnv): void {
  const res = spawnSync('docker', args, { stdio: 'inherit', env });
  if (res.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed with exit code ${res.status ?? 'unknown'}`);
  }
}

function isComposeRunning(base: string[]): boolean {
  try {
    const result = spawnSync('docker', [...base, 'ps', '--services', '--filter', 'status=running'], {
      encoding: 'utf-8',
    });
    return (result.stdout?.trim().length ?? 0) > 0;
  } catch {
    return false;
  }
}
