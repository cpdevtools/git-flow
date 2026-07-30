import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { slotStack, deploymentSlot } from '@cpdevtools/git-flow-deploy';
import { defaultHostRoot } from './compose.js';
import { bundleSlot } from '../bundle-slot.js';

export interface SwarmHandlerOptions {
  extractDir: string;
}

const PACKAGE_NAME = '@cpdevtools/git-flow-deploy-service';

export async function handleSwarm(options: SwarmHandlerOptions): Promise<void> {
  const { extractDir } = options;
  const stackFile = join(extractDir, 'stack.yml');
  // Must match the stack name in the bundle's own deployCommand, otherwise a
  // later webhook deploy updates a different stack and leaves this one running.
  const slot =
    (await bundleSlot(extractDir)) ?? deploymentSlot(PACKAGE_NAME, '0.0.0');
  const stackName = slotStack(slot);

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
    const result = spawnSync('docker', ['stack', 'services', stackName], {
      encoding: 'utf-8',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
