import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { slotStack, deploymentSlot } from '@cpdevtools/git-flow-deploy';
import { defaultHostRoot } from './compose.js';
import { bundleSlot } from '../bundle-slot.js';

export interface SwarmHandlerOptions {
  extractDir: string;
  /** GitHub token — used to log in to ghcr so the deploy has credentials to forward. */
  token: string;
}

const PACKAGE_NAME = '@cpdevtools/git-flow-deploy-service';

export async function handleSwarm(options: SwarmHandlerOptions): Promise<void> {
  const { extractDir, token } = options;
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

  // --with-registry-auth forwards the credentials in THIS daemon's config.json
  // to the nodes running the tasks; it does not obtain any. Without the login
  // there is nothing to forward and workers fail the pull on a private image.
  dockerLogin(token);

  execSync(
    `docker stack deploy --with-registry-auth -c "${stackFile}" "${stackName}"`,
    {
      stdio: 'inherit',
      // Pinned for the same reason as compose: a self-deploy runs from inside the
      // task, where $HOME is /root, so the bind sources must not depend on it.
      env: { ...process.env, DEPLOY_HOST_ROOT: defaultHostRoot() },
    },
  );
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

/** Non-fatal: a public image still deploys, and the daemon may already be authenticated. */
function dockerLogin(token: string): void {
  if (!token) return;
  const result = spawnSync(
    'docker',
    ['login', 'ghcr.io', '-u', 'token', '--password-stdin'],
    { input: token, encoding: 'utf-8' },
  );
  if (result.status !== 0) {
    console.warn(
      `Warning: docker login ghcr.io failed — private images may not pull. ${result.stderr?.trim() ?? ''}`,
    );
  }
}
