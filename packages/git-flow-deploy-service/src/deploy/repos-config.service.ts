import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { watch } from 'node:fs/promises';
import {
  readReposConfig,
  isRepoAllowed,
  reposConfigPath,
  EMPTY_REPOS_CONFIG,
  type ReposConfig,
} from '@cpdevtools/git-flow-deploy';

/**
 * Loads and hot-reloads the repos config. The matching rules themselves live in
 * @cpdevtools/git-flow-deploy so this service, the CLI, and non-node hosts
 * shelling out to `deploy-gateway repos check` all decide identically.
 */
@Injectable()
export class ReposConfigService implements OnModuleInit {
  private readonly logger = new Logger(ReposConfigService.name);
  private config: ReposConfig = { ...EMPTY_REPOS_CONFIG };

  async onModuleInit(): Promise<void> {
    await this.loadConfig();
    this.watchConfig();
  }

  isAllowed(repo: string): boolean {
    return isRepoAllowed(repo, this.config);
  }

  private async loadConfig(): Promise<void> {
    try {
      this.config = await readReposConfig();
      this.logger.log(
        `Loaded repos config (allow: ${this.config.allow.length}, deny: ${this.config.deny.length})`,
      );
    } catch (err) {
      // Keep whatever is already in memory: a corrupt or half-written file must
      // not widen access by reading as "no rules".
      this.logger.error(`Keeping previous repos config: ${(err as Error).message}`);
    }
  }

  private watchConfig(): void {
    (async () => {
      try {
        const watcher = watch(reposConfigPath());
        for await (const _event of watcher) {
          await this.loadConfig();
        }
      } catch {
        // Watch not available (file absent, etc.) — acceptable
      }
    })();
  }
}
