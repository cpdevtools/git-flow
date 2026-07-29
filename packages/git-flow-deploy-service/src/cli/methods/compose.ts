import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_TOKEN: token,
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
