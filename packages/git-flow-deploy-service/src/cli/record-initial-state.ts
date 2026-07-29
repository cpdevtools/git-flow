import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseDeployYml, deploymentSlot } from '@cpdevtools/git-flow-deploy';
import { DeploymentStateService } from '../deploy/deployment-state.service.js';
import type { ConfigService } from '../deploy/config.service.js';

/**
 * Record the deployment mode provisioned by the CLI into the shared deployment
 * state, so a later webhook deploy that switches modes (e.g. node → compose) can
 * detect the prior mode and tear it down. Without this, a CLI-bootstrapped mode
 * is invisible to the mode-change teardown and the old mode keeps running.
 *
 * Best-effort: never throws. Only writes when the bundle carries a `method` and
 * no state exists yet for the slot (so it never clobbers webhook-managed state).
 */
export async function recordInitialState(extractDir: string): Promise<void> {
  try {
    const manifest = await parseDeployYml(join(extractDir, 'deploy.yml'));
    if (!manifest.method) {
      console.warn(
        'deploy.yml has no `method` — skipping deployment-state record (mode-change teardown will be inactive for this bundle).',
      );
      return;
    }

    const versioning = manifest.versioning ?? 'singleton';
    const slot = manifest.slot ?? deploymentSlot(manifest.name, manifest.version, versioning);

    const stateDir =
      process.env['DEPLOY_STATE_DIR'] ?? join(homedir(), '.git-flow-deploy-service', 'state');
    const state = new DeploymentStateService({ stateDir } as ConfigService);

    if (state.get(slot)) {
      // Already tracked (e.g. a prior webhook deploy) — don't overwrite.
      return;
    }

    state.save(
      {
        slot,
        name: manifest.name,
        method: manifest.method,
        version: manifest.version,
        releaseId: manifest.releaseId,
        versioning,
        teardownCommand: manifest.teardownCommand,
        deployCommand: manifest.deployCommand,
      },
      extractDir,
    );
    console.log(`Recorded initial deployment state for slot "${slot}" (method: ${manifest.method}).`);
  } catch (err) {
    console.warn(`Could not record initial deployment state: ${(err as Error).message}`);
  }
}
