import { defineConfig } from 'tsup';
import { builtinModules } from 'node:module';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: false,
  clean: true,
  bundle: true,
  minify: false,
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  noExternal: [/^(?!node:)/],
  external: [...builtinModules, ...builtinModules.map(m => `node:${m}`)],
  shims: true,
  banner: {
    js: `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);`,
  },
});
