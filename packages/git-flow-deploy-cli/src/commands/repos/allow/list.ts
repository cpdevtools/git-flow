import { Command } from '@oclif/core';
import { readReposConfig } from '@cpdevtools/git-flow-deploy';

export default class ReposAllowList extends Command {
  static override description = 'List allow patterns';

  async run(): Promise<void> {
    const config = await readReposConfig();
    if (config.allow.length === 0) {
      this.log('(none — all repos permitted unless denied)');
    } else {
      for (const p of config.allow) this.log(p);
    }
  }
}
