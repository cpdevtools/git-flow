import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeploymentStateService, type DeploymentStateInput } from './deployment-state.service';
import type { ConfigService } from './config.service';

let stateDir: string;
let bundleSrc: string;
let svc: DeploymentStateService;

function makeInput(overrides: Partial<DeploymentStateInput> = {}): DeploymentStateInput {
  return {
    slot: 'org-svc',
    name: '@org/svc',
    method: 'compose',
    version: '1.2.3',
    releaseId: 5,
    versioning: 'singleton',
    teardownCommand: 'docker compose -p org-svc down',
    deployCommand: 'docker compose -p org-svc up -d',
    ...overrides,
  };
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dss-state-'));
  bundleSrc = mkdtempSync(join(tmpdir(), 'dss-bundle-'));
  writeFileSync(join(bundleSrc, 'deploy.yml'), 'name: "@org/svc"\n');
  svc = new DeploymentStateService({ stateDir } as ConfigService);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(bundleSrc, { recursive: true, force: true });
});

describe('DeploymentStateService', () => {
  it('returns undefined for an unknown slot', () => {
    expect(svc.get('nope')).toBeUndefined();
  });

  it('saves state and keeps a copy of the bundle', () => {
    const state = svc.save(makeInput(), bundleSrc);
    expect(state.bundleDir).toBe(join(stateDir, 'org-svc', 'current'));
    expect(state.updatedAt).toBeDefined();
    expect(existsSync(join(state.bundleDir, 'deploy.yml'))).toBe(true);

    const read = svc.get('org-svc');
    expect(read?.method).toBe('compose');
    expect(read?.releaseId).toBe(5);
    expect(read?.deployCommand).toBe('docker compose -p org-svc up -d');
    expect(read?.teardownCommand).toBe('docker compose -p org-svc down');
  });

  it('overwrites the retained bundle on re-save', () => {
    svc.save(makeInput(), bundleSrc);
    writeFileSync(join(bundleSrc, 'new.txt'), 'x');
    svc.save(makeInput({ releaseId: 6, version: '1.3.0' }), bundleSrc);

    expect(existsSync(join(stateDir, 'org-svc', 'current', 'new.txt'))).toBe(true);
    expect(svc.get('org-svc')?.releaseId).toBe(6);
  });

  it('keeps separate slots independent', () => {
    svc.save(makeInput({ slot: 'org-svc-v1' }), bundleSrc);
    svc.save(makeInput({ slot: 'org-svc-v2', releaseId: 9 }), bundleSrc);
    expect(svc.get('org-svc-v1')?.releaseId).toBe(5);
    expect(svc.get('org-svc-v2')?.releaseId).toBe(9);
  });

  it('clear removes the slot', () => {
    svc.save(makeInput(), bundleSrc);
    svc.clear('org-svc');
    expect(svc.get('org-svc')).toBeUndefined();
    expect(existsSync(join(stateDir, 'org-svc'))).toBe(false);
  });

  it('does not leak the state.json path when reading a corrupted file', () => {
    svc.save(makeInput(), bundleSrc);
    writeFileSync(join(stateDir, 'org-svc', 'state.json'), '{ not json');
    expect(svc.get('org-svc')).toBeUndefined();
  });
});
