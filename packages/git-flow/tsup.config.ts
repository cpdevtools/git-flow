import { defineConfig } from 'tsup';
import { builtinModules } from 'module';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export default defineConfig([
  // Main library outputs - external dependencies
  {
    entry: {
      index: 'src/index.ts',
      'version/index': 'src/version/index.ts',
      'branch/index': 'src/branch/index.ts',
      'build-pack/index': 'src/build-pack/index.ts',
      'publishing/index': 'src/publishing/index.ts',
      'publish-release/index': 'src/publish-release/index.ts',
    },
    format: ['esm'],
    dts: false, // Temporarily disabled due to workspace link issues
    sourcemap: true,
    clean: true,
    treeshake: true,
    splitting: false,
    minify: false,
    target: 'node20',
    platform: 'node',
    external: [
      ...builtinModules,
      ...builtinModules.map(m => `node:${m}`),
    ],
    async onSuccess() {
      // Post-process to add node: prefix to all bare built-in imports
      const distFiles = ['dist/publishing/index.js', 'dist/publish-release/index.js'];
      const builtins = ['path', 'fs', 'url', 'crypto', 'stream', 'util', 'events', 'http', 'https', 'zlib', 'buffer', 'querystring', 'os', 'child_process', 'net', 'tls', 'dns', 'dgram', 'readline', 'process'];
      
      for (const distFile of distFiles) {
        try {
          let content = await readFile(distFile, 'utf-8');
          for (const builtin of builtins) {
            content = content.replace(new RegExp(`from ["']${builtin}["']`, 'g'), `from "node:${builtin}"`);
          }
          await writeFile(distFile, content, 'utf-8');
          console.log(`✓ Added node: prefix to ${distFile}`);
        } catch (err) {
          // File might not exist, skip
        }
      }
    },
  },
  // CLI outputs - keep oclif external (uses dynamic requires), bundle ts-dev-utilities
  {
    entry: {
      'cli/index': 'src/cli/index.ts',
      'cli/bin': 'src/cli/bin.ts',
      'cli/commands/pack': 'src/cli/commands/pack.ts',
      'cli/commands/apply-version': 'src/cli/commands/apply-version.ts',
    },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false, // Don't clean, we're adding to existing dist
    treeshake: true,
    splitting: false,
    minify: false,
    target: 'node20',
    platform: 'node',
    external: [
      // Keep all Node.js built-ins external
      ...builtinModules,
      ...builtinModules.map(m => `node:${m}`),
      // Keep oclif external - it uses dynamic requires internally
      '@oclif/core',
      // Keep these external too - they'll be available from the test workspace or action
      '@actions/core',
      '@actions/github',
      'globby',
      'semver',
      'yaml',
      'zx',
    ],
  },
]);
