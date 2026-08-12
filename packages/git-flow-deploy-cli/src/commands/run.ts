import { Command, Flags } from '@oclif/core';
import { join } from 'node:path';
import {
  parseDeployYml,
  runDeploy,
  declaresSharedStorage,
  prepareSharedStorage,
  sharedStorageDir,
  declaresSeedStorage,
  prepareSeedStorage,
  prepareStorageMigrations,
  waitForSwarmConvergence,
} from '@cpdevtools/git-flow-deploy';
import { readSecret } from '../secrets.js';

export default class Run extends Command {
  static override description =
    'Execute deployCommand from an already-extracted deploy bundle. Streams stdout/stderr. Exits 0/1.';

  static override examples = ['<%= config.bin %> run --work-dir /tmp/deploy-gateway/123456789'];

  static override flags = {
    'work-dir': Flags.string({
      char: 'w',
      description: 'Directory containing the extracted deploy bundle',
      required: false,
      default: process.cwd(),
    }),
    manifest: Flags.string({
      char: 'm',
      description: 'Path to deploy.yml (defaults to <work-dir>/deploy.yml)',
      required: false,
    }),
    'shared-storage-base': Flags.string({
      description: 'Base path for shared storage (overrides SHARED_STORAGE_BASE_DIR)',
      required: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Run);
    const workDir = flags['work-dir'];
    const manifestPath = flags['manifest'] ?? join(workDir, 'deploy.yml');
    const sharedStorageBase =
      flags['shared-storage-base'] ?? process.env['SHARED_STORAGE_BASE_DIR'];

    const manifest = await parseDeployYml(manifestPath);

    if (sharedStorageBase && declaresSharedStorage(manifest)) {
      this.log(
        `\u25b8 Preparing shared storage: ${sharedStorageDir(manifest, sharedStorageBase)}/`,
      );
      await prepareSharedStorage(manifest, sharedStorageBase);
    }

    if (sharedStorageBase) {
      await prepareStorageMigrations(manifest, sharedStorageBase, workDir);
    }

    if (sharedStorageBase && declaresSeedStorage(manifest)) {
      this.log(`\u25b8 Seeding shared storage from bundle\u2026`);
      await prepareSeedStorage(manifest, sharedStorageBase, workDir);
    }

    this.log(`\u25b8 Running: ${manifest.deployCommand}`);

    // The deploy command logs in to the registry with $GITHUB_TOKEN before pulling
    // (`docker login … && docker stack deploy --with-registry-auth`). In production
    // the token arrives as a docker/swarm secret mounted via GITHUB_TOKEN_FILE, not
    // as an exported env var, so $GITHUB_TOKEN would otherwise be empty and pulls of
    // private/internal images fail. Resolve it here and pass it through; deploys that
    // need no registry auth simply proceed without a token.
    let deployEnv: Record<string, string> | undefined;
    try {
      deployEnv = { GITHUB_TOKEN: await readSecret('GITHUB_TOKEN') };
    } catch {
      deployEnv = undefined;
    }

    const exitCode = await runDeploy(
      manifest,
      workDir,
      (line) => {
        process.stdout.write(line + '\n');
      },
      deployEnv,
    );

    // `docker stack deploy` returns the moment the manager accepts the new spec,
    // long before any task is replaced — its exit code says nothing about whether
    // the new version actually came up. For swarm, wait for the rolling update to
    // converge (or roll back) so a failed rollout fails the deploy instead of
    // reporting success at "Updating service …".
    if (exitCode === 0 && manifest.method === 'swarm' && manifest.swarmService) {
      this.log(`\u25b8 Waiting for ${manifest.swarmService} to converge\u2026`);
      const result = await waitForSwarmConvergence(manifest.swarmService, {
        onLine: (line) => {
          process.stdout.write(line + '\n');
        },
      });
      if (result.state === 'converged') {
        this.log(`\u2713 ${manifest.swarmService} is running v${manifest.version}.`);
      } else if (result.timedOut) {
        this.log(
          `\u2717 ${manifest.swarmService} did not converge within the timeout ` +
            `(last: ${result.raw ?? result.state}).`,
        );
        this.exit(1);
      } else {
        this.log(
          `\u2717 ${manifest.swarmService} rolled back${result.message ? `: ${result.message}` : ''}.`,
        );
        this.exit(1);
      }
    }

    this.exit(exitCode);
  }
}
