import { Command, Args, Flags } from '@oclif/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchDeployBundle,
  declaresSharedStorage,
  prepareSharedStorage,
  sharedStorageDir,
  declaresSeedStorage,
  prepareSeedStorage,
  prepareStorageMigrations,
  runDeploy,
} from '@cpdevtools/git-flow-deploy';
import { readSecret } from '../secrets.js';

export default class Deploy extends Command {
  static override description =
    'Fetch a deploy bundle from a GitHub Release and immediately execute its deployCommand (fetch + run in one shot)';

  static override examples = [
    '<%= config.bin %> deploy owner/repo 123456789',
    '<%= config.bin %> deploy owner/repo 123456789 --bundle deploy-swarm.zip',
    '<%= config.bin %> deploy owner/repo 123456789 --dest /tmp/my-deploy --shared-storage-base /docker-nfs/swarm',
  ];

  static override args = {
    repo: Args.string({ description: 'GitHub repo (owner/repo)', required: true }),
    'release-id': Args.integer({ description: 'GitHub Release ID', required: true }),
  };

  static override flags = {
    dest: Flags.string({
      char: 'd',
      description: 'Working directory for extraction (default: temp dir)',
      required: false,
    }),
    bundle: Flags.string({
      description:
        'Release asset to deploy (e.g. deploy-swarm.zip). Required: releases carry per-method bundles, not a generic deploy.zip.',
      required: true,
    }),
    'shared-storage-base': Flags.string({
      description: 'Base path for shared storage (overrides SHARED_STORAGE_BASE_DIR)',
      required: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Deploy);
    const repo = args['repo'];
    const releaseId = args['release-id'];
    const dest = flags['dest'] ?? join(tmpdir(), 'deploy-gateway', String(releaseId));
    const bundle = flags['bundle'];
    const sharedStorageBase =
      flags['shared-storage-base'] ?? process.env['SHARED_STORAGE_BASE_DIR'];

    let token: string;
    try {
      token = await readSecret('GITHUB_TOKEN');
    } catch (err) {
      this.error((err as Error).message);
    }

    this.log(`▸ Fetching ${bundle} from release ${releaseId}...`);
    const manifest = await fetchDeployBundle(token, repo, releaseId, dest, bundle);

    if (sharedStorageBase && declaresSharedStorage(manifest)) {
      this.log(`▸ Preparing shared storage: ${sharedStorageDir(manifest, sharedStorageBase)}/`);
      await prepareSharedStorage(manifest, sharedStorageBase);
    }

    if (sharedStorageBase) {
      await prepareStorageMigrations(manifest, sharedStorageBase, dest);
    }

    if (sharedStorageBase && declaresSeedStorage(manifest)) {
      this.log(`▸ Seeding shared storage from bundle…`);
      await prepareSeedStorage(manifest, sharedStorageBase, dest);
    }

    this.log(`▸ Running: ${manifest.deployCommand}`);

    const exitCode = await runDeploy(manifest, dest, (line) => {
      process.stdout.write(line + '\n');
    });

    this.exit(exitCode);
  }
}
