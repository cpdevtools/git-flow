import { defineConfig } from 'tsup';
import { builtinModules } from 'node:module';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs'],
  outExtension: ({ format }) => ({ js: '.js' }),
  dts: false,
  sourcemap: false,
  clean: true,
  bundle: true,
  minify: false,
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  noExternal: [/^(?!@cpdevtools\/git-flow)/], // Bundle everything except git-flow library
  external: [
    ...builtinModules, 
    ...builtinModules.map(m => `node:${m}`),
    '@cpdevtools/git-flow',
    '@cpdevtools/git-flow/build-pack',
    '@cpdevtools/git-flow/publish-release'
  ],
  shims: false,
});
