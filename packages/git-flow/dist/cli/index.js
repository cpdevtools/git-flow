import { pathToFileURL } from 'url';
import { existsSync } from 'fs';
import { join } from 'path';

// src/cli/config-loader.ts
async function loadConfig(cwd) {
  const configPaths = [
    join(cwd, "cpdevtools.config.ts"),
    join(cwd, "cpdevtools.config.js"),
    join(cwd, "cpdevtools.config.mjs")
  ];
  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const configUrl = pathToFileURL(configPath).href;
        const module = await import(configUrl);
        const config = module.default || module;
        return config;
      } catch (error) {
        console.warn(`Warning: Failed to load config from ${configPath}:`, error);
      }
    }
  }
  return void 0;
}

export { loadConfig };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map