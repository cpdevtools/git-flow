import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  sourcemap: true,
  clean: true,
  dts: false,
  minify: false,
  external: [],
  outExtension: () => ({ js: '.js' }),
});
