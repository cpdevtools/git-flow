import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
    index: 'src/index.ts',
    'config-loader': 'src/config-loader.ts',
    'commands/pack': 'src/commands/pack.ts',
    'commands/apply-version': 'src/commands/apply-version.ts',
    'commands/pack-deploy': 'src/commands/pack-deploy.ts',
    'pack-deploy': 'src/pack-deploy.ts',
  },
  format: ['cjs'],
  target: 'node24',
  dts: true,
  sourcemap: true,
  clean: true,
  bundle: false,
  platform: 'node',
});
