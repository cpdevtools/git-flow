import { defineConfig } from 'tsup';
import { builtinModules } from 'node:module';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node20',
  platform: 'node',
  bundle: true,
  minify: false,
  splitting: false,
  noExternal: [/.*/],
  external: [...builtinModules, ...builtinModules.map(m => `node:${m}`)],
  shims: true,
  banner: {
    js: `import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);`,
  },
});
