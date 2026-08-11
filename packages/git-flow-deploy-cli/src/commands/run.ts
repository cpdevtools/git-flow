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
} from '@cpdevtools/git-flow-deploy';

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

    const exitCode = await runDeploy(manifest, workDir, (line) => {
      process.stdout.write(line + '\n');
    });

    this.exit(exitCode);
  }
}
