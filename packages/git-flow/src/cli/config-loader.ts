/**
 * Configuration loader for cpdevtools.config.ts files
 */

import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CPDevToolsConfig } from './types.js';

/**
 * Load cpdevtools.config.ts from a project directory
 * @param cwd - Project root directory
 * @returns Configuration object or undefined if not found
 */
export async function loadConfig(cwd: string): Promise<CPDevToolsConfig | undefined> {
  const configPaths = [
    join(cwd, 'cpdevtools.config.ts'),
    join(cwd, 'cpdevtools.config.js'),
    join(cwd, 'cpdevtools.config.mjs'),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const configUrl = pathToFileURL(configPath).href;
        const module = await import(configUrl);
        
        // Support both default export and named exports
        const config: CPDevToolsConfig = module.default || module;
        
        return config;
      } catch (error) {
        console.warn(`Warning: Failed to load config from ${configPath}:`, error);
      }
    }
  }

  return undefined;
}
