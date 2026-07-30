import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDeployYml, deploymentSlot } from '@cpdevtools/git-flow-deploy';
import { ConfigService } from './config.service.js';
import { DeploymentStateService } from './deployment-state.service.js';
import { getServiceInfo } from '../version.js';

/**
 * Seed the running service's own deployment mode into the durable state on boot.
 *
 * A mode-change teardown (e.g. node → compose) only fires when the controller
 * finds a `prior` state record for the slot. That record is normally written by
 * CLI provisioning (`recordInitialState`) or by a successful self-deploy handled
 * by THIS code. But when the service is first upgraded to this version by an
 * OLDER instance (which never recorded state), the slot state is empty — so the
 * very first mode change would silently skip teardown and leave the old mode
 * running (port clash). This bootstrap hook closes that gap: if our own slot has
 * no state yet, record the current mode from our own bundle's deploy.yml.
 *
 * Best-effort: never throws; only writes when the manifest is ours, carries a
 * `method`, and no state exists yet (so it never clobbers webhook-managed state).
 */
@Injectable()
export class SelfRegistrationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SelfRegistrationService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly state: DeploymentStateService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const manifestPath = this.resolveSelfManifestPath();
      if (!manifestPath) return;

      const manifest = await parseDeployYml(manifestPath);
      const self = getServiceInfo();

      // Only self-register OUR own bundle — never seed from an unrelated
      // deploy.yml that happens to sit in the current working directory.
      if (manifest.name !== self.name) return;
      if (!manifest.method) return;

      const versioning = manifest.versioning ?? 'singleton';
      const slot =
        manifest.slot ??
        deploymentSlot(manifest.name, manifest.version, versioning);

      if (this.state.get(slot)) return; // already tracked — don't overwrite.

      this.state.save(
        {
          slot,
          name: manifest.name,
          method: manifest.method,
          version: manifest.version,
          releaseId: manifest.releaseId ?? 0,
          versioning,
          teardownCommand: manifest.teardownCommand,
          deployCommand: manifest.deployCommand,
        },
        dirname(manifestPath),
      );
      this.logger.log(
        `Self-registered running mode for slot "${slot}" (method: ${manifest.method}) — ` +
          'mode-change teardown is now armed.',
      );
    } catch (err) {
      this.logger.warn(
        `Could not self-register deployment state: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Locate our own deploy.yml. Prefer an explicit override (compose/swarm can
   * bind-mount it in), otherwise fall back to the current working directory,
   * which for a node (pm2) deploy is the extracted bundle dir that also holds
   * ecosystem.config.js — exactly what the teardown command needs.
   */
  private resolveSelfManifestPath(): string | undefined {
    const explicit = process.env['DEPLOY_SELF_MANIFEST'];
    if (explicit && existsSync(explicit)) return explicit;
    const cwdManifest = join(process.cwd(), 'deploy.yml');
    if (existsSync(cwdManifest)) return cwdManifest;
    return undefined;
  }
}
