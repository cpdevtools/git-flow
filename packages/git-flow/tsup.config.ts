import { defineConfig } from 'tsup';
import { builtinModules } from 'module';

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
  },
  // CLI outputs - bundle all dependencies except Node.js built-ins
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
    noExternal: [/.*/], // Bundle everything
    external: [
      // Keep all Node.js built-ins external
      ...builtinModules,
      ...builtinModules.map(m => `node:${m}`),
    ],
  },
]);
