import { Command, Args } from '@oclif/core';
import { readReposConfig, writeReposConfig } from '../../../repos-config.js';

export default class ReposDenyAdd extends Command {
  static override description = 'Add a glob pattern to the deny list (deny wins over allow)';
  static override examples = ['<%= config.bin %> repos deny add "untrusted-org/*"'];
  static override args = {
    pattern: Args.string({ description: 'Glob pattern', required: true }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(ReposDenyAdd);
    const config = await readReposConfig();
    if (!config.deny.includes(args['pattern'])) {
      config.deny.push(args['pattern']);
      await writeReposConfig(config);
    }
    this.log(`Added to deny: ${args['pattern']}`);
  }
}
