import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { readFile, watch } from 'node:fs/promises';
import { minimatch } from 'minimatch';

interface ReposConfig {
  allow: string[];
  deny: string[];
}

const CONFIG_PATH = '/etc/deploy-gateway/repos.json';

/**
 * Loads and hot-reloads /etc/deploy-gateway/repos.json.
 * Authorization rules:
 *   1. If repo matches any deny pattern → denied
 *   2. If allow list is non-empty and repo matches no allow pattern → denied
 *   3. Otherwise → permitted
 */
@Injectable()
export class ReposConfigService implements OnModuleInit {
  private readonly logger = new Logger(ReposConfigService.name);
  private config: ReposConfig = { allow: [], deny: [] };

  async onModuleInit(): Promise<void> {
    await this.loadConfig();
    this.watchConfig();
  }

  isAllowed(repo: string): boolean {
    for (const pattern of this.config.deny) {
      if (minimatch(repo, pattern)) return false;
    }
    if (this.config.allow.length > 0) {
      return this.config.allow.some((pattern) => minimatch(repo, pattern));
    }
    return true;
  }

  private async loadConfig(): Promise<void> {
    try {
      const raw = await readFile(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ReposConfig>;
      this.config = {
        allow: Array.isArray(parsed.allow) ? parsed.allow : [],
        deny: Array.isArray(parsed.deny) ? parsed.deny : [],
      };
      this.logger.log(
        `Loaded repos config (allow: ${this.config.allow.length}, deny: ${this.config.deny.length})`,
      );
    } catch {
      // File not present on first start — allow all
      this.config = { allow: [], deny: [] };
    }
  }

  private watchConfig(): void {
    (async () => {
      try {
        const watcher = watch(CONFIG_PATH);
        for await (const _event of watcher) {
          await this.loadConfig();
        }
      } catch {
        // Watch not available (file absent, etc.) — acceptable
      }
    })();
  }
}
