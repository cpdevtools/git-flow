import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { defaultHostRoot } from './compose.js';

export interface SwarmHandlerOptions {
  extractDir: string;
}

const PACKAGE_NAME = '@cpdevtools/git-flow-deploy-service';

/** Mirrors the safeName() helper in deploy-methods.ts */
function safeName(name: string): string {
  return name.replace(/@/g, '').replace(/\//g, '-');
}

export async function handleSwarm(options: SwarmHandlerOptions): Promise<void> {
  const { extractDir } = options;
  const stackFile = join(extractDir, 'stack.yml');
  // e.g. "@cpdevtools/git-flow-deploy-service" → "cpdevtools-git-flow-deploy-service"
  // underscores used for stack name (docker convention)
  const stackName = safeName(PACKAGE_NAME).replace(/-/g, '_');

  const isDeployed = isStackDeployed(stackName);

  if (!isDeployed) {
    console.log(`Deploying stack ${stackName} (first-time)...`);
  } else {
    console.log(`Updating stack ${stackName}...`);
  }

  execSync(`docker stack deploy -c "${stackFile}" "${stackName}"`, {
    stdio: 'inherit',
    // Pinned for the same reason as compose: a self-deploy runs from inside the
    // task, where $HOME is /root, so the bind sources must not depend on it.
    env: { ...process.env, DEPLOY_HOST_ROOT: defaultHostRoot() },
  });
  console.log(`Stack ${stackName} deployed ✓`);
}

function isStackDeployed(stackName: string): boolean {
  try {
    const result = spawnSync('docker', ['stack', 'services', stackName], { encoding: 'utf-8' });
    return result.status === 0;
  } catch {
    return false;
  }
}
