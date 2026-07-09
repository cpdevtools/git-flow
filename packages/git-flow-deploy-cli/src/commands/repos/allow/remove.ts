import { Command, Args } from '@oclif/core';
import { readReposConfig, writeReposConfig } from '../../../repos-config.js';

export default class ReposAllowRemove extends Command {
  static override description = 'Remove a glob pattern from the allow list';
  static override args = {
    pattern: Args.string({ description: 'Pattern to remove', required: true }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(ReposAllowRemove);
    const config = await readReposConfig();
    config.allow = config.allow.filter((p) => p !== args['pattern']);
    await writeReposConfig(config);
    this.log(`Removed from allow: ${args['pattern']}`);
  }
}
