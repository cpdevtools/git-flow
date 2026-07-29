import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('@cpdevtools/git-flow-deploy', () => {
  const actual = jest.requireActual('@cpdevtools/git-flow-deploy');
  return { __esModule: true, ...actual, parseDeployYml: jest.fn() };
});

import { parseDeployYml } from '@cpdevtools/git-flow-deploy';
import { recordInitialState } from './record-initial-state.js';
import { DeploymentStateService } from '../deploy/deployment-state.service.js';
import type { ConfigService } from '../deploy/config.service.js';

const parseMock = parseDeployYml as jest.Mock;

describe('recordInitialState', () => {
  let extractDir: string;
  let stateDir: string;
  let state: DeploymentStateService;

  beforeEach(() => {
    extractDir = mkdtempSync(join(tmpdir(), 'gfmc-extract-'));
    writeFileSync(join(extractDir, 'ecosystem.config.js'), '// bundle');
    stateDir = mkdtempSync(join(tmpdir(), 'gfmc-state-'));
    process.env['DEPLOY_STATE_DIR'] = stateDir;
    state = new DeploymentStateService({ stateDir } as ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env['DEPLOY_STATE_DIR'];
    rmSync(extractDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('records the provisioned mode (method, teardown, saved bundle) into state', async () => {
    parseMock.mockResolvedValue({
      name: '@cpdevtools/git-flow-deploy-service',
      version: '0.4.12',
      repo: 'https://github.com/cpdevtools/git-flow',
      releaseId: 12345,
      method: 'node',
      slot: 'cpdevtools-git-flow-deploy-service',
      deployCommand: 'bash restart.sh',
      teardownCommand: 'pm2 delete ecosystem.config.js',
    });

    await recordInitialState(extractDir);

    const saved = state.get('cpdevtools-git-flow-deploy-service');
    expect(saved?.method).toBe('node');
    expect(saved?.teardownCommand).toBe('pm2 delete ecosystem.config.js');
    expect(saved?.deployCommand).toBe('bash restart.sh');
    expect(saved?.bundleDir).toContain(join('cpdevtools-git-flow-deploy-service', 'current'));
  });

  it('skips recording when the bundle has no method', async () => {
    parseMock.mockResolvedValue({
      name: '@cpdevtools/git-flow-deploy-service',
      version: '0.4.12',
      repo: 'https://github.com/cpdevtools/git-flow',
      releaseId: 12345,
      deployCommand: 'bash restart.sh',
    });

    await recordInitialState(extractDir);

    expect(state.get('cpdevtools-git-flow-deploy-service')).toBeUndefined();
  });

  it('does not clobber existing state for the slot', async () => {
    const slot = 'cpdevtools-git-flow-deploy-service';
    const priorBundle = mkdtempSync(join(tmpdir(), 'gfmc-prior-'));
    state.save(
      {
        slot,
        name: '@cpdevtools/git-flow-deploy-service',
        method: 'compose',
        version: '9.9.9',
        releaseId: 999,
        versioning: 'singleton',
        teardownCommand: 'docker compose down',
        deployCommand: 'docker compose up -d',
      },
      priorBundle,
    );
    rmSync(priorBundle, { recursive: true, force: true });

    parseMock.mockResolvedValue({
      name: '@cpdevtools/git-flow-deploy-service',
      version: '0.4.12',
      repo: 'https://github.com/cpdevtools/git-flow',
      releaseId: 12345,
      method: 'node',
      slot,
      deployCommand: 'bash restart.sh',
      teardownCommand: 'pm2 delete ecosystem.config.js',
    });

    await recordInitialState(extractDir);

    // Existing (compose) record is preserved — CLI does not overwrite it.
    expect(state.get(slot)?.method).toBe('compose');
  });

  it('never throws when parsing fails', async () => {
    parseMock.mockRejectedValue(new Error('no deploy.yml'));
    await expect(recordInitialState(extractDir)).resolves.toBeUndefined();
  });
});
