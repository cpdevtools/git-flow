import { Command } from '@oclif/core';
import { readReposConfig } from '../../repos-config.js';

export default class ReposList extends Command {
  static override description = 'Show all allow and deny patterns';

  async run(): Promise<void> {
    const config = await readReposConfig();
    this.log('Allow:');
    if (config.allow.length === 0) {
      this.log('  (none — all repos permitted unless denied)');
    } else {
      for (const p of config.allow) this.log(`  ${p}`);
    }
    this.log('Deny:');
    if (config.deny.length === 0) {
      this.log('  (none)');
    } else {
      for (const p of config.deny) this.log(`  ${p}`);
    }
  }
}
