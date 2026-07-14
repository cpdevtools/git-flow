import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: ['cjs'],
  target: 'node18',
  bundle: true,
  clean: false, // nest build already manages dist/ — don't wipe it
  banner: {
    js: '#!/usr/bin/env node',
  },
  outDir: 'dist',
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node',
  shims: false,
  dts: false,
  sourcemap: false,
});
