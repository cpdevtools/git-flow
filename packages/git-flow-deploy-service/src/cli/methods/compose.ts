import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

export interface ComposeHandlerOptions {
  extractDir: string;
}

export async function handleCompose(options: ComposeHandlerOptions): Promise<void> {
  const { extractDir } = options;
  const composeFile = join(extractDir, 'docker-compose.yml');

  const isRunning = isComposeRunning(composeFile);

  if (!isRunning) {
    console.log('Starting service with docker compose (first-time)...');
    execSync(`docker compose -f "${composeFile}" up -d`, { stdio: 'inherit' });
  } else {
    console.log('Existing docker compose service detected — pulling and restarting...');
    execSync(`docker compose -f "${composeFile}" pull`, { stdio: 'inherit' });
    execSync(`docker compose -f "${composeFile}" up -d`, { stdio: 'inherit' });
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
