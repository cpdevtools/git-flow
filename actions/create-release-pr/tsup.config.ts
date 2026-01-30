import { defineConfig } from 'tsup';
import { builtinModules } from 'node:module';
import { createRequire } from 'node:module';

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
  noExternal: [/.*/],
  external: [...builtinModules, ...builtinModules.map(m => `node:${m}`)],
  outExtension: () => ({ js: '.js' }),
  shims: true,
  banner: {
    js: `import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);`,
  },
});
