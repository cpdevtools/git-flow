import { Command, Args } from '@oclif/core';
import { readReposConfig, writeReposConfig } from '../../../repos-config.js';

export default class ReposDenyRemove extends Command {
  static override description = 'Remove a glob pattern from the deny list';
  static override args = {
    pattern: Args.string({ description: 'Pattern to remove', required: true }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(ReposDenyRemove);
    const config = await readReposConfig();
    config.deny = config.deny.filter((p) => p !== args['pattern']);
    await writeReposConfig(config);
    this.log(`Removed from deny: ${args['pattern']}`);
  }
}
