import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Mocks ────────────────────────────────────────────────────────────────────
// Keep the real slot helpers (deploymentSlot) but stub the side-effecting deploy
// primitives so we can drive teardown / deploy / rollback exit codes.
jest.mock('@cpdevtools/git-flow-deploy', () => {
  const actual = jest.requireActual('@cpdevtools/git-flow-deploy');
  return {
    __esModule: true,
    ...actual,
    fetchDeployBundle: jest.fn(),
    prepareSharedStorage: jest.fn(),
    runDeploy: jest.fn(),
  };
});

jest.mock('../version.js', () => ({
  __esModule: true,
  getServiceInfo: jest.fn(() => ({ name: 'unknown', version: '0.0.0' })),
}));

jest.mock('node:child_process', () => ({
  __esModule: true,
  spawn: jest.fn(() => ({ unref: jest.fn() })),
  spawnSync: jest.fn(),
}));

import { fetchDeployBundle, runDeploy } from '@cpdevtools/git-flow-deploy';
import { spawn, spawnSync } from 'node:child_process';
import { getServiceInfo } from '../version.js';
import { DeployController } from './deploy.controller.js';
import { DeployStore } from './deploy-store.js';
import { DeploymentStateService } from './deployment-state.service.js';
import type { ConfigService } from './config.service.js';
import type { ReposConfigService } from './repos-config.service.js';
import { SUPERVISOR_PLAN_FILE, type SupervisorPlan } from '../supervisor/plan.js';

const fetchMock = fetchDeployBundle as jest.Mock;
const runMock = runDeploy as jest.Mock;
const spawnMock = spawn as unknown as jest.Mock;
const spawnSyncMock = spawnSync as unknown as jest.Mock;
const serviceInfoMock = getServiceInfo as jest.Mock;

const SELF = { name: '@cpdevtools/git-flow-deploy-service', version: '9.9.9' };

describe('DeployController mode-change teardown/rollback', () => {
  let root: string;
  let cliPath: string;
  let store: DeployStore;
  let state: DeploymentStateService;
  let controller: DeployController;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gfmc-'));
    process.env['DEPLOY_WORK_DIR'] = root;
    // Pin the supervisor CLI to a real file so assertions don't depend on the
    // jest runner's argv and the launcher's existence check is satisfied.
    cliPath = join(root, 'cli.cjs');
    writeFileSync(cliPath, '// supervisor cli');
    process.env['DEPLOY_SUPERVISOR_CLI'] = cliPath;
    serviceInfoMock.mockReturnValue({ ...SELF });

    store = new DeployStore();
    state = new DeploymentStateService({ stateDir: join(root, 'state') } as ConfigService);
    const config = {
      workDir: root,
      githubToken: 'token',
      sharedStorageBaseDir: undefined,
    } as unknown as ConfigService;
    const repos = { isAllowed: () => true } as unknown as ReposConfigService;
    controller = new DeployController(store, config, repos, state);

    // fetchDeployBundle: create the release work dir + a bundle file, return manifest.
    fetchMock.mockImplementation(
      async (_token: string, _repo: string, releaseId: number, destDir: string) => {
        mkdirSync(destDir, { recursive: true });
        writeFileSync(join(destDir, 'deploy.yml'), 'bundle');
        return currentManifest(releaseId);
      },
    );
    // runDeploy: resolve the exit code registered for the invoked command.
    runMock.mockImplementation((m: { deployCommand: string }) =>
      Promise.resolve(exitCodes[m.deployCommand] ?? 0),
    );
    spawnMock.mockReturnValue({ unref: jest.fn() });
    // Default: this process is not identifiable as a container, so containerized
    // self deploys fall back to running inline (matches a node-mode host).
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: '' });
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env['DEPLOY_SUPERVISOR_CLI'];
    rmSync(root, { recursive: true, force: true });
  });

  // Per-test knobs.
  let currentManifest: (releaseId: number) => Record<string, unknown>;
  let exitCodes: Record<string, number>;

  beforeEach(() => {
    exitCodes = {};
    currentManifest = () => ({});
  });

  /** Seed a prior deployment state for `slot`, backed by a real bundle dir. */
  function seedPrior(slot: string, method: string, opts: Partial<Record<string, unknown>> = {}) {
    const bundleSrc = mkdtempSync(join(tmpdir(), 'gfmc-prior-'));
    writeFileSync(join(bundleSrc, 'old-bundle'), method);
    state.save(
      {
        slot,
        name: '@org/app',
        method,
        version: '1.0.0',
        releaseId: 900,
        versioning: 'singleton',
        teardownCommand: (opts['teardownCommand'] as string) ?? `teardown-${method}`,
        deployCommand: (opts['deployCommand'] as string) ?? `deploy-${method}`,
      },
      bundleSrc,
    );
    rmSync(bundleSrc, { recursive: true, force: true });
  }

  async function run(releaseId: number): Promise<void> {
    const record = store.start(releaseId, 'owner/repo');
    await (controller as unknown as {
      runDeployAsync: (r: unknown, repo: string, id: number, b?: string) => Promise<void>;
    }).runDeployAsync(record, 'owner/repo', releaseId, undefined);
  }

  /** Make `docker ps`/`docker inspect` report a single running container as ours. */
  function mockSelfContainer(id: string, image: string): void {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'ps') return { status: 0, stdout: `${id}\n`, stderr: '' };
      if (args[0] === 'inspect') return { status: 0, stdout: `${id} ${image}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
  }

  /** Args of the `docker run` that launched the supervisor container, if any. */
  function dockerRunArgs(): string[] | undefined {
    const call = spawnSyncMock.mock.calls.find((c) => (c[1] as string[])[0] === 'run');
    return call?.[1] as string[] | undefined;
  }

  /** The plan handed to the supervisor for a release, read back off disk. */
  function readPlan(releaseId: number): SupervisorPlan {
    return JSON.parse(
      readFileSync(join(root, String(releaseId), SUPERVISOR_PLAN_FILE), 'utf-8'),
    ) as SupervisorPlan;
  }

  /** A manifest for a same-mode compose self deploy. */
  function selfComposeManifest(releaseId: number): Record<string, unknown> {
    return {
      name: SELF.name,
      version: SELF.version,
      repo: 'owner/repo',
      releaseId,
      method: 'compose',
      deployCommand: 'compose-up',
      teardownCommand: 'compose-down',
    };
  }

  it('mode change: tears down old mode, then brings up new mode, and persists new state', async () => {
    seedPrior('org-app', 'node', { teardownCommand: 'pm2 delete', deployCommand: 'restart.sh' });
    currentManifest = (releaseId) => ({
      name: '@org/app',
      version: '2.0.0',
      repo: 'owner/repo',
      releaseId,
      method: 'compose',
      deployCommand: 'compose-up',
      teardownCommand: 'compose-down',
    });

    await run(1001);

    const cmds = runMock.mock.calls.map((c) => (c[0] as { deployCommand: string }).deployCommand);
    expect(cmds).toEqual(['pm2 delete', 'compose-up']);
    // teardown ran in the OLD bundle dir
    expect(runMock.mock.calls[0][1]).toContain(join('state', 'org-app', 'current'));

    const saved = state.get('org-app');
    expect(saved?.method).toBe('compose');
    expect(saved?.releaseId).toBe(1001);
    expect(store.get(1001)?.status).toBe('completed');
  });

  it('mode change: aborts (no rollback of prior) when teardown of old mode fails', async () => {
    seedPrior('org-app', 'node', { teardownCommand: 'pm2 delete', deployCommand: 'restart.sh' });
    exitCodes['pm2 delete'] = 1;
    currentManifest = (releaseId) => ({
      name: '@org/app',
      version: '2.0.0',
      repo: 'owner/repo',
      releaseId,
      method: 'compose',
      deployCommand: 'compose-up',
      teardownCommand: 'compose-down',
    });

    await run(1002);

    const cmds = runMock.mock.calls.map((c) => (c[0] as { deployCommand: string }).deployCommand);
    expect(cmds).toEqual(['pm2 delete']); // new mode never attempted
    expect(state.get('org-app')?.method).toBe('node'); // unchanged
    expect(store.get(1002)?.status).toBe('failed');
  });

  it('mode change: rolls back to old mode when the new mode fails to come up', async () => {
    seedPrior('org-app', 'node', { teardownCommand: 'pm2 delete', deployCommand: 'restart.sh' });
    exitCodes['compose-up'] = 1; // new mode fails
    currentManifest = (releaseId) => ({
      name: '@org/app',
      version: '2.0.0',
      repo: 'owner/repo',
      releaseId,
      method: 'compose',
      deployCommand: 'compose-up',
      teardownCommand: 'compose-down',
    });

    await run(1003);

    const cmds = runMock.mock.calls.map((c) => (c[0] as { deployCommand: string }).deployCommand);
    expect(cmds).toEqual(['pm2 delete', 'compose-up', 'restart.sh']); // teardown, deploy, rollback
    expect(runMock.mock.calls[2][1]).toContain(join('state', 'org-app', 'current')); // rollback in old bundle
    expect(state.get('org-app')?.method).toBe('node'); // still old mode
    expect(store.get(1003)?.status).toBe('failed');
  });

  it('same method: no teardown, just deploys and updates state', async () => {
    seedPrior('org-app', 'compose', { teardownCommand: 'compose-down', deployCommand: 'compose-up' });
    currentManifest = (releaseId) => ({
      name: '@org/app',
      version: '2.1.0',
      repo: 'owner/repo',
      releaseId,
      method: 'compose',
      deployCommand: 'compose-up',
      teardownCommand: 'compose-down',
    });

    await run(1004);

    const cmds = runMock.mock.calls.map((c) => (c[0] as { deployCommand: string }).deployCommand);
    expect(cmds).toEqual(['compose-up']); // no teardown for same method
    expect(state.get('org-app')?.releaseId).toBe(1004);
    expect(store.get(1004)?.status).toBe('completed');
  });

  it('different major: deploys into a separate slot without touching the other major', async () => {
    seedPrior('org-app-v1', 'compose', { teardownCommand: 'compose-down -p app-v1', deployCommand: 'up -p app-v1' });
    currentManifest = (releaseId) => ({
      name: '@org/app',
      version: '2.0.0',
      repo: 'owner/repo',
      releaseId,
      method: 'compose',
      versioning: 'major',
      slot: 'org-app-v2',
      deployCommand: 'up -p app-v2',
      teardownCommand: 'down -p app-v2',
    });

    await run(1005);

    const cmds = runMock.mock.calls.map((c) => (c[0] as { deployCommand: string }).deployCommand);
    expect(cmds).toEqual(['up -p app-v2']); // v1 untouched
    expect(state.get('org-app-v1')?.method).toBe('compose'); // v1 slot intact
    expect(state.get('org-app-v2')?.releaseId).toBe(1005); // v2 slot created
    expect(store.get(1005)?.status).toBe('completed');
  });

  it('self mode-change: hands off to a detached supervisor instead of tearing down inline', async () => {
    const slot = 'cpdevtools-git-flow-deploy-service';
    seedPrior(slot, 'node', { teardownCommand: 'pm2 delete', deployCommand: 'restart.sh' });
    currentManifest = (releaseId) => ({
      name: SELF.name,
      version: SELF.version,
      repo: 'owner/repo',
      releaseId,
      method: 'compose',
      deployCommand: 'compose-up',
      teardownCommand: 'compose-down',
    });

    await run(2001);

    expect(runMock).not.toHaveBeenCalled(); // nothing run inline
    // Leaving node: a setsid session on the host escapes pm2's tree and can
    // still drive docker, so no sibling container is needed.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe('setsid');
    expect(spawnMock.mock.calls[0][1]).toEqual([
      process.execPath,
      cliPath,
      'supervise',
      '--plan',
      join(root, '2001', SUPERVISOR_PLAN_FILE),
    ]);

    const plan = readPlan(2001);
    expect(plan.teardown!.command).toBe('pm2 delete');
    expect(plan.teardown!.cwd).toContain(join('state', slot, 'current'));
    expect(plan.deploy).toEqual({ cwd: join(root, '2001'), command: 'compose-up' });
    expect(plan.rollback!.command).toBe('restart.sh'); // back to the node mode

    const rec = store.get(2001);
    expect(rec?.selfUpdate).toBe(true);
    expect(rec?.status).toBe('running'); // handed off, not finalized
    expect(state.get(slot)?.method).toBe('node'); // supervisor (mocked) hasn't committed
    expect(existsSync(join(root, 'state', slot, 'state.new.json'))).toBe(true); // staged for commit
    // stop the unref'd tail interval so it can't fire between tests
    store.finish(rec!, 0);
  });

  it('self mode-change out of a container: refuses BEFORE tearing anything down', async () => {
    const slot = 'cpdevtools-git-flow-deploy-service';
    seedPrior(slot, 'compose', { teardownCommand: 'compose-down', deployCommand: 'compose-up-old' });
    mockSelfContainer('container-id-abc', 'ghcr.io/org/svc:1.2.3');
    currentManifest = (releaseId) => ({
      name: SELF.name,
      version: SELF.version,
      repo: 'owner/repo',
      releaseId,
      method: 'node',
      deployCommand: 'restart.sh',
      teardownCommand: 'pm2 delete',
    });

    await run(2002);

    // Nothing may run: no teardown, no supervisor anywhere. A container cannot
    // start a host pm2 process, so attempting it only takes the service down.
    expect(runMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(dockerRunArgs()).toBeUndefined();
    expect(existsSync(join(root, '2002', SUPERVISOR_PLAN_FILE))).toBe(false);

    const rec = store.get(2002);
    expect(rec?.status).toBe('failed');
    expect(rec?.log.some((l) => l.includes('Unsupported mode change: compose → node'))).toBe(true);
    expect(rec?.log.some((l) => l.includes('Nothing was torn down'))).toBe(true);
    expect(state.get(slot)?.method).toBe('compose'); // still running as it was
  });

  it('self mode-change between containerized modes: uses a sibling supervisor container', async () => {
    const slot = 'cpdevtools-git-flow-deploy-service';
    seedPrior(slot, 'compose', { teardownCommand: 'compose-down', deployCommand: 'compose-up-old' });
    mockSelfContainer('container-id-abc', 'ghcr.io/org/svc:1.2.3');
    currentManifest = (releaseId) => ({
      name: SELF.name,
      version: SELF.version,
      repo: 'owner/repo',
      releaseId,
      method: 'swarm',
      deployCommand: 'stack-deploy',
      teardownCommand: 'stack-rm',
    });

    await run(2003);

    expect(runMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled(); // setsid would die with our container
    const args = dockerRunArgs();
    expect(args).toEqual(expect.arrayContaining(['--volumes-from', 'container-id-abc']));
    expect(args!.slice(-5)).toEqual([
      'ghcr.io/org/svc:1.2.3',
      cliPath,
      'supervise',
      '--plan',
      join(root, '2003', SUPERVISOR_PLAN_FILE),
    ]);

    const plan = readPlan(2003);
    expect(plan.teardown!.command).toBe('compose-down');
    expect(plan.deploy.command).toBe('stack-deploy');

    const rec = store.get(2003);
    expect(rec?.status).toBe('running');
    store.finish(rec!, 0);
  });

  it('self mode-change: refuses rather than tearing down inline when the container is unidentifiable', async () => {
    const slot = 'cpdevtools-git-flow-deploy-service';
    seedPrior(slot, 'compose', { teardownCommand: 'compose-down', deployCommand: 'compose-up-old' });
    // Default spawnSync mock reports failure for both `docker ps` and `docker inspect`.
    currentManifest = (releaseId) => ({
      name: SELF.name,
      version: SELF.version,
      repo: 'owner/repo',
      releaseId,
      method: 'swarm',
      deployCommand: 'stack-deploy',
      teardownCommand: 'stack-rm',
    });

    await run(2004);

    expect(runMock).not.toHaveBeenCalled();
    const rec = store.get(2004);
    expect(rec?.status).toBe('failed');
    expect(rec?.log.some((l) => l.includes('Nothing was torn down'))).toBe(true);
    expect(state.get(slot)?.method).toBe('compose');
  });

  it('containerized self deploy: hands off to a sibling supervisor container', async () => {
    const slot = 'cpdevtools-git-flow-deploy-service';
    seedPrior(slot, 'compose', { teardownCommand: 'compose-down', deployCommand: 'compose-up-old' });
    currentManifest = selfComposeManifest;
    mockSelfContainer('container-id-abc', 'ghcr.io/org/svc:1.2.3');

    await run(3001);

    expect(runMock).not.toHaveBeenCalled(); // never run inline — that would SIGKILL us mid-swap
    const args = dockerRunArgs();
    expect(args).toBeDefined();
    // Inherits our mounts (bundle dir, state dir, docker socket) without needing host paths.
    expect(args).toEqual(expect.arrayContaining(['--volumes-from', 'container-id-abc']));
    expect(args).toEqual(expect.arrayContaining(['--detach', '--rm']));
    // Runs OUR image (always local, already has node + docker + compose) and our CLI.
    expect(args).toEqual(expect.arrayContaining(['--entrypoint', 'node']));
    expect(args!.slice(-5)).toEqual([
      'ghcr.io/org/svc:1.2.3',
      cliPath,
      'supervise',
      '--plan',
      join(root, '3001', SUPERVISOR_PLAN_FILE),
    ]);

    const plan = readPlan(3001);
    expect(plan.teardown).toBeUndefined(); // same mode — nothing to tear down
    expect(plan.deploy).toEqual({ cwd: join(root, '3001'), command: 'compose-up' });
    expect(plan.rollback!.command).toBe('compose-up-old');
    expect(plan.commit.stateNewFile).toBe(join(root, 'state', slot, 'state.new.json'));

    const rec = store.get(3001);
    expect(rec?.selfUpdate).toBe(true);
    expect(rec?.status).toBe('running'); // handed off, not finalized
    expect(state.get(slot)?.version).toBe('1.0.0'); // supervisor commits state, not us
    expect(existsSync(join(root, 'state', slot, 'state.new.json'))).toBe(true); // staged for commit
    store.finish(rec!, 0);
  });

  it('containerized self deploy: falls back to an inline deploy when our container is unidentifiable', async () => {
    seedPrior('cpdevtools-git-flow-deploy-service', 'compose', { deployCommand: 'compose-up-old' });
    currentManifest = selfComposeManifest;
    // Default spawnSync mock reports failure for both `docker ps` and `docker inspect`.

    await run(3002);

    expect(dockerRunArgs()).toBeUndefined();
    expect(runMock).toHaveBeenCalledTimes(1); // best effort rather than doing nothing
    const rec = store.get(3002);
    expect(rec?.log.some((l) => l.includes('could not identify'))).toBe(true);
    store.finish(rec!, 0);
  });
});
