import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { getDeployMethod, type DeployMethodContext } from './deploy-methods.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deploy-methods-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(method: string, versioning?: 'singleton' | 'major'): DeployMethodContext {
  return {
    projectCwd: dir,
    deployOutputDir: dir,
    projectName: '@org/svc',
    version: '2.3.5',
    method,
    versioning,
  };
}

async function readDeployYml(): Promise<Record<string, unknown>> {
  return parse(await readFile(join(dir, 'deploy.yml'), 'utf-8')) as Record<string, unknown>;
}

describe('docker.compose generateDeployYml', () => {
  it('singleton: slot = safeName and pins a stable -p project on up + down', async () => {
    await getDeployMethod('docker', 'compose')!.generateDeployYml(ctx('compose'));
    const m = await readDeployYml();
    expect(m.method).toBe('compose');
    expect(m.slot).toBe('org-svc');
    expect(m.versioning).toBe('singleton');
    expect(m.deployCommand).toBe('docker compose -p org-svc pull && docker compose -p org-svc up -d');
    expect(m.teardownCommand).toBe('docker compose -p org-svc down');
  });

  it('major: slot includes -v<major> in both commands', async () => {
    await getDeployMethod('docker', 'compose')!.generateDeployYml(ctx('compose', 'major'));
    const m = await readDeployYml();
    expect(m.slot).toBe('org-svc-v2');
    expect(m.versioning).toBe('major');
    expect(m.deployCommand).toContain('-p org-svc-v2');
    expect(m.teardownCommand).toBe('docker compose -p org-svc-v2 down');
  });
});

describe('docker.swarm generateDeployYml', () => {
  it('singleton: stack name uses underscores', async () => {
    await getDeployMethod('docker', 'swarm')!.generateDeployYml(ctx('swarm'));
    const m = await readDeployYml();
    expect(m.method).toBe('swarm');
    expect(m.slot).toBe('org-svc');
    expect(m.deployCommand).toBe('docker stack deploy -c stack.yml org_svc');
    expect(m.teardownCommand).toBe('docker stack rm org_svc');
  });

  it('major: stack name includes _v<major>', async () => {
    await getDeployMethod('docker', 'swarm')!.generateDeployYml(ctx('swarm', 'major'));
    const m = await readDeployYml();
    expect(m.slot).toBe('org-svc-v2');
    expect(m.deployCommand).toBe('docker stack deploy -c stack.yml org_svc_v2');
    expect(m.teardownCommand).toBe('docker stack rm org_svc_v2');
  });
});

describe('npm.node generateDeployYml', () => {
  it('singleton with file-based pm2 teardown', async () => {
    await getDeployMethod('npm', 'node')!.generateDeployYml(ctx('node'));
    const m = await readDeployYml();
    expect(m.method).toBe('node');
    expect(m.slot).toBe('org-svc');
    expect(m.versioning).toBe('singleton');
    expect(m.teardownCommand).toBe('pm2 delete ecosystem.config.js');
    expect(String(m.deployCommand)).toContain('restart.sh');
  });
});
