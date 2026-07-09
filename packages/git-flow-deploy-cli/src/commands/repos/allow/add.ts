import { Command, Args } from '@oclif/core';
import { readReposConfig, writeReposConfig } from '../../../repos-config.js';

export default class ReposAllowAdd extends Command {
  static override description = 'Add a glob pattern to the allow list';
  static override examples = ['<%= config.bin %> repos allow add "cpdevtools/*"'];
  static override args = {
    pattern: Args.string({ description: 'Glob pattern (e.g. owner/repo or owner/*)', required: true }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(ReposAllowAdd);
    const config = await readReposConfig();
    if (!config.allow.includes(args['pattern'])) {
      config.allow.push(args['pattern']);
      await writeReposConfig(config);
    }
    this.log(`Added to allow: ${args['pattern']}`);
  }
}
