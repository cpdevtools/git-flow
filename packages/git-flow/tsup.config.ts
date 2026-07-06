import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'version/index': 'src/version/index.ts',
    'branch/index': 'src/branch/index.ts',
    'build-pack/index': 'src/build-pack/index.ts',
    'artifacts/index': 'src/artifacts/index.ts',
    'publishing/index': 'src/publishing/index.ts',
    'publish-release/index': 'src/publish-release/index.ts',
  },
  format: ['cjs'],
  target: 'node24',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  bundle: true,
  external: ['@actions/core', '@actions/github', 'globby', 'semver', 'yaml', 'zx'],
  platform: 'node',
});

