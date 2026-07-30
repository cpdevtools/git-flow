import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('@cpdevtools/git-flow-deploy', () => {
  const actual = jest.requireActual('@cpdevtools/git-flow-deploy');
  return { __esModule: true, ...actual, parseDeployYml: jest.fn() };
});
jest.mock('../version.js', () => ({ getServiceInfo: jest.fn() }));

import { parseDeployYml } from '@cpdevtools/git-flow-deploy';
import { getServiceInfo } from '../version.js';
import { SelfRegistrationService } from './self-registration.service.js';
import { DeploymentStateService } from './deployment-state.service.js';
import type { ConfigService } from './config.service.js';

const parseMock = parseDeployYml as jest.Mock;
const serviceInfoMock = getServiceInfo as jest.Mock;

const SELF = { name: '@cpdevtools/git-flow-deploy-service', version: '0.4.12' };
const SLOT = 'cpdevtools-git-flow-deploy-service';

describe('SelfRegistrationService', () => {
  let bundleDir: string;
  let manifestPath: string;
  let stateDir: string;
  let state: DeploymentStateService;
  let svc: SelfRegistrationService;

  beforeEach(() => {
    bundleDir = mkdtempSync(join(tmpdir(), 'gfsr-bundle-'));
    manifestPath = join(bundleDir, 'deploy.yml');
    writeFileSync(manifestPath, '# bundle');
    writeFileSync(join(bundleDir, 'ecosystem.config.js'), '// bundle');
    process.env['DEPLOY_SELF_MANIFEST'] = manifestPath;

    stateDir = mkdtempSync(join(tmpdir(), 'gfsr-state-'));
    state = new DeploymentStateService({ stateDir } as ConfigService);
    svc = new SelfRegistrationService({ stateDir } as ConfigService, state);

    serviceInfoMock.mockReturnValue({ ...SELF });
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env['DEPLOY_SELF_MANIFEST'];
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  const nodeManifest = () => ({
    name: SELF.name,
    version: SELF.version,
    repo: 'https://github.com/cpdevtools/git-flow',
    releaseId: 12345,
    method: 'node',
    slot: SLOT,
    versioning: 'singleton',
    deployCommand: 'bash restart.sh',
    teardownCommand: 'pm2 delete ecosystem.config.js',
  });

  it('self-registers the running mode when the slot has no state yet', async () => {
    parseMock.mockResolvedValue(nodeManifest());

    await svc.onApplicationBootstrap();

    const saved = state.get(SLOT);
    expect(saved?.method).toBe('node');
    expect(saved?.teardownCommand).toBe('pm2 delete ecosystem.config.js');
    expect(saved?.deployCommand).toBe('bash restart.sh');
    expect(saved?.bundleDir).toContain(join(SLOT, 'current'));
  });

  it('does not register when the manifest is a different app', async () => {
    parseMock.mockResolvedValue({
      ...nodeManifest(),
      name: '@other/app',
      slot: 'other-app',
    });

    await svc.onApplicationBootstrap();

    expect(state.get(SLOT)).toBeUndefined();
    expect(state.get('other-app')).toBeUndefined();
  });

  it('skips when the manifest has no method', async () => {
    const { method, ...noMethod } = nodeManifest();
    void method;
    parseMock.mockResolvedValue(noMethod);

    await svc.onApplicationBootstrap();

    expect(state.get(SLOT)).toBeUndefined();
  });

  it('does not clobber existing state for the slot', async () => {
    const prior = mkdtempSync(join(tmpdir(), 'gfsr-prior-'));
    state.save(
      {
        slot: SLOT,
        name: SELF.name,
        method: 'compose',
        version: '9.9.9',
        releaseId: 999,
        versioning: 'singleton',
        teardownCommand: 'docker compose down',
        deployCommand: 'docker compose up -d',
      },
      prior,
    );
    rmSync(prior, { recursive: true, force: true });

    parseMock.mockResolvedValue(nodeManifest());

    await svc.onApplicationBootstrap();

    expect(state.get(SLOT)?.method).toBe('compose');
  });

  it('does nothing when no self manifest can be resolved', async () => {
    delete process.env['DEPLOY_SELF_MANIFEST'];
    // cwd (the package dir) has no deploy.yml, so nothing resolves.
    await svc.onApplicationBootstrap();

    expect(parseMock).not.toHaveBeenCalled();
    expect(state.get(SLOT)).toBeUndefined();
  });

  it('never throws when parsing fails', async () => {
    parseMock.mockRejectedValue(new Error('bad yaml'));
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
