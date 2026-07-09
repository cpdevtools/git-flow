import { Command, Args, Flags } from '@oclif/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchDeployBundle, prepareSharedStorage, runDeploy } from '@cpdevtools/git-flow-deploy';

export default class Deploy extends Command {
  static override description =
    'Fetch deploy.zip from a GitHub Release and immediately execute its deployCommand (fetch + run in one shot)';

  static override examples = [
    '<%= config.bin %> deploy owner/repo 123456789',
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
    const sharedStorageBase =
      flags['shared-storage-base'] ?? process.env['SHARED_STORAGE_BASE_DIR'];

    const token = process.env['GITHUB_TOKEN'];
    if (!token) this.error('GITHUB_TOKEN environment variable is required');

    this.log(`▸ Fetching deploy.zip from release ${releaseId}...`);
    const manifest = await fetchDeployBundle(token, repo, releaseId, dest);

    if (sharedStorageBase && manifest.sharedStorage) {
      this.log(`▸ Preparing shared storage: ${sharedStorageBase}/${manifest.name}/`);
      await prepareSharedStorage(manifest, sharedStorageBase);
    }

    this.log(`▸ Running: ${manifest.deployCommand}`);

    const exitCode = await runDeploy(manifest, dest, (line) => {
      process.stdout.write(line + '\n');
    });

    this.exit(exitCode);
  }
}
