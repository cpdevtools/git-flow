import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
// Via index.js on purpose: deploy-methods.js only *defines* the built-in
// handlers now — registering them is index.js applying the built-in plugin
// manifest, the same path an installed plugin takes.
import './index.js';
import {
  getDeployMethod,
  SWARM_DEPLOY_COMMAND,
  type DeployMethodContext,
} from './deploy-methods.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deploy-methods-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(
  method: string,
  versioning?: 'singleton' | 'major',
  stack?: string,
): DeployMethodContext {
  return {
    projectCwd: dir,
    workspaceRoot: dir,
    deployOutputDir: dir,
    projectName: '@org/svc',
    version: '2.3.5',
    method,
    versioning,
    stack,
  };
}

async function readDeployYml(): Promise<Record<string, unknown>> {
  return parse(await readFile(join(dir, 'deploy.yml'), 'utf-8')) as Record<string, unknown>;
}

async function readEnv(): Promise<string> {
  return readFile(join(dir, '.env'), 'utf-8');
}

describe('docker.compose generateDeployYml', () => {
  it('singleton: slot = safeName and pins a stable -p project on up + down', async () => {
    await getDeployMethod('docker-image', 'compose')!.generateDeployYml(ctx('compose'));
    const m = await readDeployYml();
    expect(m.method).toBe('compose');
    expect(m.slot).toBe('org-svc');
    expect(m.versioning).toBe('singleton');
    expect(m.deployCommand).toBe(
      'echo "$GITHUB_TOKEN" | docker login ghcr.io -u token --password-stdin 2>/dev/null; docker compose -p org-svc pull && docker compose -p org-svc up -d --force-recreate --remove-orphans',
    );
    expect(m.teardownCommand).toBe('docker compose -p org-svc down');
  });

  it('major: slot includes -v<major> in both commands', async () => {
    await getDeployMethod('docker-image', 'compose')!.generateDeployYml(ctx('compose', 'major'));
    const m = await readDeployYml();
    expect(m.slot).toBe('org-svc-v2');
    expect(m.versioning).toBe('major');
    expect(m.deployCommand).toContain('-p org-svc-v2');
    expect(m.teardownCommand).toBe('docker compose -p org-svc-v2 down');
  });

  it('pins the image to the release version via .env', async () => {
    await getDeployMethod('docker-image', 'compose')!.generateDeployYml(ctx('compose'));
    expect(await readEnv()).toBe('DEPLOY_IMAGE_TAG=2.3.5\n');
  });

  it('preserves unrelated .env lines and replaces a stale tag', async () => {
    await writeFile(join(dir, '.env'), 'FOO=bar\nDEPLOY_IMAGE_TAG=0.0.1\n');
    await getDeployMethod('docker-image', 'compose')!.generateDeployYml(ctx('compose'));
    expect(await readEnv()).toBe('FOO=bar\nDEPLOY_IMAGE_TAG=2.3.5\n');
  });
});

describe('docker.swarm generateDeployYml', () => {
  it('singleton: deployCommand and teardownCommand use the @{ STACK } placeholder', async () => {
    await getDeployMethod('docker-image', 'swarm')!.generateDeployYml(ctx('swarm'));
    const m = await readDeployYml();
    expect(m.method).toBe('swarm');
    expect(m.slot).toBe('org-svc');
    expect(m.deployCommand).toBe(SWARM_DEPLOY_COMMAND);
    expect(m.teardownCommand).toBe('docker stack rm @{ STACK }');
  });

  it('major: slot is versioned, @{ STACK } placeholder is present for rendering', async () => {
    await getDeployMethod('docker-image', 'swarm')!.generateDeployYml(ctx('swarm', 'major'));
    const m = await readDeployYml();
    expect(m.slot).toBe('org-svc-v2');
    // @{ STACK } is resolved to slotStack(slot) by renderDeployTemplates at pack time
    expect(m.deployCommand).toBe(SWARM_DEPLOY_COMMAND);
    expect(m.teardownCommand).toBe('docker stack rm @{ STACK }');
  });

  it('shared stack: tears down only this service, leaving its siblings up', async () => {
    await getDeployMethod('docker-image', 'swarm')!.generateDeployYml(
      ctx('swarm', 'major', 'webservice'),
    );
    const m = await readDeployYml();
    expect(m.teardownCommand).toBe('docker service rm @{ STACK_SERVICE_ID }');
  });

  it('bakes the swarm service name so the deploy side can wait for convergence', async () => {
    await getDeployMethod('docker-image', 'swarm')!.generateDeployYml(ctx('swarm', 'major'));
    const m = await readDeployYml();
    // @{ STACK_SERVICE_ID } is resolved to the docker service name at pack time.
    expect(m.swarmService).toBe('@{ STACK_SERVICE_ID }');
  });

  it('deployCommand merges stack.$DEPLOY_STACK_ENV.yml and fails when it is missing', () => {
    expect(SWARM_DEPLOY_COMMAND).toContain('STACK_FILES="-c stack.yml"');
    expect(SWARM_DEPLOY_COMMAND).toContain('if [ -n "$DEPLOY_STACK_ENV" ]');
    expect(SWARM_DEPLOY_COMMAND).toContain('[ -f "stack.$DEPLOY_STACK_ENV.yml" ]');
    expect(SWARM_DEPLOY_COMMAND).toContain('exit 1');
    expect(SWARM_DEPLOY_COMMAND).toContain(
      'docker stack deploy --with-registry-auth $STACK_FILES @{ STACK }',
    );
  });

  it('pins the image to the release version via .env', async () => {
    await getDeployMethod('docker-image', 'swarm')!.generateDeployYml(ctx('swarm'));
    expect(await readEnv()).toBe('DEPLOY_IMAGE_TAG=2.3.5\n');
  });
});

describe('npm.node generateDeployYml', () => {
  it('singleton with file-based pm2 teardown', async () => {
    await getDeployMethod('npm', 'node')!.generateDeployYml(ctx('node'));
    const m = await readDeployYml();
    expect(m.method).toBe('node');
    expect(m.slot).toBe('org-svc');
    expect(m.versioning).toBe('singleton');
    expect(m.teardownCommand).toBe('pm2 stop ecosystem.config.js');
    expect(String(m.deployCommand)).toContain('restart.sh');
  });
});
