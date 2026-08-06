import { Command, Args, Flags } from '@oclif/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchDeployBundle } from '@cpdevtools/git-flow-deploy';
import { readSecret } from '../secrets.js';

export default class Fetch extends Command {
  static override description =
    'Download and extract a deploy bundle from a GitHub Release into a local directory';

  static override examples = [
    '<%= config.bin %> fetch owner/repo 123456789 --bundle deploy-swarm.zip',
    '<%= config.bin %> fetch owner/repo 123456789 --bundle deploy-swarm.zip --dest /tmp/my-deploy',
  ];

  static override args = {
    repo: Args.string({ description: 'GitHub repo (owner/repo)', required: true }),
    'release-id': Args.integer({ description: 'GitHub Release ID', required: true }),
  };

  static override flags = {
    dest: Flags.string({ char: 'd', description: 'Destination directory', required: false }),
    bundle: Flags.string({
      char: 'b',
      description: 'Release asset name (e.g. deploy-swarm.zip)',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Fetch);
    const repo = args['repo'];
    const releaseId = args['release-id'];
    const bundle = flags['bundle'];
    const dest = flags['dest'] ?? join(tmpdir(), 'deploy-gateway', String(releaseId));

    let token: string;
    try {
      token = await readSecret('GITHUB_TOKEN');
    } catch (err) {
      this.error((err as Error).message);
    }

    this.log(`\u25b8 Fetching ${bundle} from release ${releaseId}...`);
    const manifest = await fetchDeployBundle(token, repo, releaseId, dest, bundle);
    this.log(`\u25b8 Extracted to: ${dest}`);
    // Machine-readable line; callers use it to learn the resolved version before the deploy runs.
    process.stdout.write(`DEPLOY_TARGET_VERSION:${manifest.version}\n`);
  }
}
