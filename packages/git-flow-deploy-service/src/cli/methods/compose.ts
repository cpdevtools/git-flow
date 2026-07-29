import { execSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
}

export async function handleCompose(options: ComposeHandlerOptions): Promise<void> {
  const { extractDir, token, hmacSecret } = options;
  const composeFile = join(extractDir, 'docker-compose.yml');

  const isRunning = isComposeRunning(composeFile);

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
    console.log('Starting service with docker compose (first-time)...');
    execSync(`docker compose -f "${composeFile}" up -d --force-recreate --remove-orphans`, { stdio: 'inherit', env });
  } else {
    console.log('Existing docker compose service detected — pulling and restarting...');
    execSync(`docker compose -f "${composeFile}" pull`, { stdio: 'inherit', env });
    execSync(`docker compose -f "${composeFile}" up -d --force-recreate --remove-orphans`, { stdio: 'inherit', env });
  }

  console.log('docker compose deployment complete ✓');
}

function isComposeRunning(composeFile: string): boolean {
  try {
    const result = spawnSync(
      'docker',
      ['compose', '-f', composeFile, 'ps', '--services', '--filter', 'status=running'],
      { encoding: 'utf-8' },
    );
    return (result.stdout?.trim().length ?? 0) > 0;
  } catch {
    return false;
  }
}
