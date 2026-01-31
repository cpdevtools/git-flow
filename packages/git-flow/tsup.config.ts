import { defineConfig } from 'tsup';

export default defineConfig([
  // Library outputs - CommonJS format (bundle for clean consumption)
  {
    entry: {
      'index': 'src/index.ts',
      'version/index': 'src/version/index.ts', 
      'branch/index': 'src/branch/index.ts',
      'build-pack/index': 'src/build-pack/index.ts',
      'publishing/index': 'src/publishing/index.ts',
      'publish-release/index': 'src/publish-release/index.ts',
    },
    format: ['cjs'],
    target: 'node20',
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    bundle: true, // Bundle to avoid module resolution issues
    external: ['@actions/core', '@actions/github', 'globby', 'semver', 'yaml', 'zx'],
    platform: 'node',
  },
  // CLI outputs - CommonJS format (compatible with library)
  {
    entry: {
      'cli/index': 'src/cli/index.ts',
      'cli/bin': 'src/cli/bin.ts',
      'cli/config-loader': 'src/cli/config-loader.ts',
      'cli/commands/pack': 'src/cli/commands/pack.ts',
      'cli/commands/apply-version': 'src/cli/commands/apply-version.ts',
    },
    format: ['cjs'],
    target: 'node20',
    dts: true,
    sourcemap: true,
    clean: false,
    bundle: false,
    platform: 'node',
  },
]);
