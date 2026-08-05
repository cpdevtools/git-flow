import { Command } from '@oclif/core';
import { readReposConfig } from '@cpdevtools/git-flow-deploy';

export default class ReposDenyList extends Command {
  static override description = 'List deny patterns';

  async run(): Promise<void> {
    const config = await readReposConfig();
    if (config.deny.length === 0) {
      this.log('(none)');
    } else {
      for (const p of config.deny) this.log(p);
    }
  }
}
