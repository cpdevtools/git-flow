import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'version/index': 'src/version/index.ts',
    'branch/index': 'src/branch/index.ts',
    'build-pack/index': 'src/build-pack/index.ts',
    'cli/index': 'src/cli/index.ts',
    'cli/pack': 'src/cli/pack.ts',
    'cli/apply-version': 'src/cli/apply-version.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  minify: false,
  target: 'node20',
});
