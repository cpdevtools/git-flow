import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveSupervisorCli, supervisorPlacement } from './launcher.js';

describe('supervisorPlacement', () => {
  it.each([
    ['node', 'node', 'bare'],
    ['node', 'compose', 'bare'],
    ['node', 'swarm', 'bare'],
    [undefined, 'compose', 'bare'],
    ['compose', 'compose', 'container'],
    ['compose', 'swarm', 'container'],
    ['swarm', 'compose', 'container'],
    // Leaving a container for the host: the supervisor would have to install and
    // start a process on the Docker host, which no container can do.
    ['compose', 'node', 'unsupported'],
    ['swarm', 'node', 'unsupported'],
  ])('%s → %s is %s', (from, to, expected) => {
    expect(supervisorPlacement(from, to)).toBe(expected);
  });
});

describe('resolveSupervisorCli', () => {
  const realArgv1 = process.argv[1];

  afterEach(() => {
    process.argv[1] = realArgv1;
    delete process.env['DEPLOY_SUPERVISOR_CLI'];
  });

  it('is not derived from argv[1], which pm2 replaces with its own wrapper', () => {
    // Verbatim from a deploy host running under pm2 cluster mode: argv[1] pointed
    // into pm2's lib dir, so an argv-derived path resolved to pm2/lib/cli.cjs and
    // every node → containerized mode change was refused.
    const pm2Wrapper =
      '/usr/local/share/nvm/versions/node/v24.16.0/lib/node_modules/pm2/lib/ProcessContainer.js';
    process.argv[1] = pm2Wrapper;

    const cli = resolveSupervisorCli();

    expect(cli).not.toContain('/pm2/');
    expect(dirname(cli)).not.toBe(dirname(pm2Wrapper));
    // Anchored on this module's own location instead.
    expect(cli).toBe(resolve(__dirname, '..', 'cli.cjs'));
  });

  it('always returns an absolute path', () => {
    // The image starts us as `node dist/main` from WORKDIR /app, so a relative
    // argv[1] must not leak through — a supervisor container runs with
    // `--workdir <bundleDir>`, where a relative path means something else.
    process.argv[1] = 'dist/main';
    expect(resolveSupervisorCli().startsWith('/')).toBe(true);
  });

  it('honours the DEPLOY_SUPERVISOR_CLI escape hatch', () => {
    process.env['DEPLOY_SUPERVISOR_CLI'] = '/somewhere/else/cli.cjs';
    expect(resolveSupervisorCli()).toBe('/somewhere/else/cli.cjs');
  });

  it('prefers a candidate that actually exists', () => {
    const cli = resolveSupervisorCli();
    const candidates = [
      resolve(__dirname, '..', 'cli.cjs'),
      resolve(__dirname, 'cli.cjs'),
      resolve(dirname(process.argv[1] ?? ''), 'cli.cjs'),
    ];
    const existing = candidates.find((c) => existsSync(c));
    if (existing) expect(cli).toBe(existing);
    else expect(cli).toBe(candidates[0]); // falls back to the canonical location
  });
});
