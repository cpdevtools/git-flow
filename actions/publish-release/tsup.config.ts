import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs'],
  dts: false,
  sourcemap: true,
  clean: true,
  bundle: true,
  minify: false,
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  noExternal: [/.*/], // Bundle ALL dependencies
  splitting: false,
});
