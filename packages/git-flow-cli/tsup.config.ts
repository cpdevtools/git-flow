import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
    index: 'src/index.ts',
    'config-loader': 'src/config-loader.ts',
    'commands/apply-version': 'src/commands/apply-version.ts',
    'commands/deploy': 'src/commands/deploy.ts',
    'commands/pack': 'src/commands/pack.ts',
    'commands/pack-deploy': 'src/commands/pack-deploy.ts',
    'commands/version': 'src/commands/version.ts',
  },
  format: ['cjs'],
  target: 'node24',
  dts: true,
  sourcemap: true,
  clean: true,
  bundle: true,
  platform: 'node',
});
