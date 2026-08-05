import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
    'commands/fetch': 'src/commands/fetch.ts',
    'commands/run': 'src/commands/run.ts',
    'commands/deploy': 'src/commands/deploy.ts',
    'commands/repos/list': 'src/commands/repos/list.ts',
    'commands/repos/check': 'src/commands/repos/check.ts',
    'commands/repos/allow/add': 'src/commands/repos/allow/add.ts',
    'commands/repos/allow/remove': 'src/commands/repos/allow/remove.ts',
    'commands/repos/allow/list': 'src/commands/repos/allow/list.ts',
    'commands/repos/deny/add': 'src/commands/repos/deny/add.ts',
    'commands/repos/deny/remove': 'src/commands/repos/deny/remove.ts',
    'commands/repos/deny/list': 'src/commands/repos/deny/list.ts',
    'commands/hmac/sign': 'src/commands/hmac/sign.ts',
    'commands/hmac/verify': 'src/commands/hmac/verify.ts',
  },
  format: ['cjs'],
  target: 'node24',
  dts: false,
  sourcemap: true,
  clean: true,
  bundle: true,
  platform: 'node',
});
