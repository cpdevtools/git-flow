import { Command, Args, Flags } from '@oclif/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchDeployBundle } from '@cpdevtools/git-flow-deploy';
import { readSecret } from '../secrets.js';

export default class Fetch extends Command {
  static override description =
    'Download and extract deploy.zip from a GitHub Release into a local directory';

  static override examples = [
    '<%= config.bin %> fetch owner/repo 123456789',
    '<%= config.bin %> fetch owner/repo 123456789 --dest /tmp/my-deploy',
  ];

  static override args = {
    repo: Args.string({ description: 'GitHub repo (owner/repo)', required: true }),
    'release-id': Args.integer({ description: 'GitHub Release ID', required: true }),
  };

  static override flags = {
    dest: Flags.string({ char: 'd', description: 'Destination directory', required: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Fetch);
    const repo = args['repo'];
    const releaseId = args['release-id'];
    const dest = flags['dest'] ?? join(tmpdir(), 'deploy-gateway', String(releaseId));

    let token: string;
    try {
      token = await readSecret('GITHUB_TOKEN');
    } catch (err) {
      this.error((err as Error).message);
    }

    this.log(`Fetching deploy.zip for release ${releaseId} of ${repo}...`);
    const manifest = await fetchDeployBundle(token, repo, releaseId, dest);
    this.log(`Extracted to: ${dest}`);
    this.log(`Service: ${manifest.name} v${manifest.version}`);
    this.log(`Deploy command: ${manifest.deployCommand}`);
  }
}
