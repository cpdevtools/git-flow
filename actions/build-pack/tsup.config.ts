import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['cjs'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node20',
  platform: 'node',
  bundle: true,
  minify: false,
  splitting: false,
  noExternal: [/.*/], // Bundle ALL dependencies
});
