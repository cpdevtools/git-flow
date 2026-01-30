import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'version/index': 'src/version/index.ts',
    'branch/index': 'src/branch/index.ts',
    'build-pack/index': 'src/build-pack/index.ts',
    'publishing/index': 'src/publishing/index.ts',
    'publish-release/index': 'src/publish-release/index.ts',
    'cli/index': 'src/cli/index.ts',
    'cli/bin': 'src/cli/bin.ts',
    'cli/commands/pack': 'src/cli/commands/pack.ts',
    'cli/commands/apply-version': 'src/cli/commands/apply-version.ts',
  },
  format: ['esm'],
  dts: false, // Temporarily disabled due to workspace link issues
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  minify: false,
  target: 'node20',
});
