import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
// Via index.js on purpose: deploy-methods.js only *defines* the built-in
// handlers now — registering them is index.js applying the built-in plugin
// manifest, the same path an installed plugin takes.
import './index.js';
import {
  getDeployMethod,
  pagesSlotPath,
  SWARM_DEPLOY_COMMAND,
  SWARM_JOB_DEPLOY_COMMAND,
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

describe('docker.swarm-job generateDeployYml', () => {
  it('emits method: swarm-job and the one-shot job deployCommand', async () => {
    await getDeployMethod('docker-image', 'swarm-job')!.generateDeployYml(ctx('swarm-job'));
    const m = await readDeployYml();
    expect(m.method).toBe('swarm-job');
    expect(m.deployCommand).toBe(SWARM_JOB_DEPLOY_COMMAND);
  });

  it('bakes the job service name so the deploy side can poll .ServiceStatus', async () => {
    await getDeployMethod('docker-image', 'swarm-job')!.generateDeployYml(
      ctx('swarm-job', 'major'),
    );
    const m = await readDeployYml();
    expect(m.swarmService).toBe('@{ STACK_SERVICE_ID }');
  });

  it('re-runs exactly one fresh iteration on an existing service, none on first create', () => {
    // First create: stack deploy runs the job once; no forced update.
    expect(SWARM_JOB_DEPLOY_COMMAND).toContain(
      'if docker service inspect @{ STACK_SERVICE_ID } >/dev/null 2>&1; then PRE=1; else PRE=0; fi',
    );
    // Existing service: force exactly one new iteration after reconciling the spec.
    expect(SWARM_JOB_DEPLOY_COMMAND).toContain(
      '[ "$PRE" = 1 ] && docker service update --force --detach @{ STACK_SERVICE_ID } || true',
    );
    expect(SWARM_JOB_DEPLOY_COMMAND).toContain(
      'docker stack deploy --with-registry-auth $STACK_FILES @{ STACK }',
    );
  });

  it('shared stack: tears down only this job service', async () => {
    await getDeployMethod('docker-image', 'swarm-job')!.generateDeployYml(
      ctx('swarm-job', 'major', 'webservice'),
    );
    const m = await readDeployYml();
    expect(m.teardownCommand).toBe('docker service rm @{ STACK_SERVICE_ID }');
  });

  it('is registered as a docker-image deploy method', () => {
    expect(getDeployMethod('docker-image', 'swarm-job')).toBeTruthy();
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

describe('static-site.gh-pages', () => {
  async function buildSite(sub: string): Promise<void> {
    await mkdir(join(dir, sub, 'chunks'), { recursive: true });
    await writeFile(join(dir, sub, 'index.html'), '<html><head><base href="/"></head></html>');
    await writeFile(join(dir, sub, 'chunks', 'a.js'), 'x="@{ raw }"');
  }

  function siteCtx(
    versioning?: 'singleton' | 'major',
    artifact: Record<string, unknown> = {},
  ): DeployMethodContext {
    return {
      ...ctx('gh-pages', versioning),
      deployOutputDir: join(dir, 'out'),
      artifact: { type: 'static-site', name: '@org/svc', ...artifact } as never,
    };
  }

  it('copies the built site into site/ and writes the deploy script', async () => {
    await buildSite('dist');
    const handler = getDeployMethod('static-site', 'gh-pages')!;
    const c = siteCtx();

    await handler.copyFiles(c);
    await handler.generateDeployYml(c);

    expect(existsSync(join(dir, 'out', 'site', 'index.html'))).toBe(true);
    expect(existsSync(join(dir, 'out', 'site', 'chunks', 'a.js'))).toBe(true);
    const script = await readFile(join(dir, 'out', 'gh-pages-deploy.sh'), 'utf-8');
    expect(script).toContain('GH_PAGES_DEST');
    expect(script).toContain('root.files');
  });

  it('singleton: lands in the slot folder', async () => {
    await buildSite('dist');
    const handler = getDeployMethod('static-site', 'gh-pages')!;
    const c = siteCtx('singleton');
    await handler.copyFiles(c);
    await handler.generateDeployYml(c);

    const yml = parse(await readFile(join(dir, 'out', 'deploy.yml'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(yml.method).toBe('gh-pages');
    expect(yml.slot).toBe('org-svc');
    expect(yml.pagesPath).toBe('org-svc');
    expect(yml.pagesRoot).toBe(false);
    expect(yml.deployCommand).toBe("sh ./gh-pages-deploy.sh 'org-svc' '@org/svc' '2.3.5'");
  });

  it('major: each major gets its own folder', async () => {
    await buildSite('dist');
    const handler = getDeployMethod('static-site', 'gh-pages')!;
    const c = siteCtx('major');
    await handler.copyFiles(c);
    await handler.generateDeployYml(c);

    const yml = parse(await readFile(join(dir, 'out', 'deploy.yml'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(yml.slot).toBe('org-svc-v2');
    expect(yml.pagesPath).toBe('org-svc/v2');
  });

  it('pagesRoot: empty path, singleton only', async () => {
    await buildSite('dist');
    const handler = getDeployMethod('static-site', 'gh-pages')!;
    const c = siteCtx('singleton', { pagesRoot: true });
    await handler.copyFiles(c);
    await handler.generateDeployYml(c);

    const yml = parse(await readFile(join(dir, 'out', 'deploy.yml'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(yml.pagesPath).toBe('');
    expect(yml.pagesRoot).toBe(true);
    expect(yml.deployCommand).toBe("sh ./gh-pages-deploy.sh '' '@org/svc' '2.3.5'");

    await expect(handler.generateDeployYml(siteCtx('major', { pagesRoot: true }))).rejects.toThrow(
      /only a singleton can own the Pages root/,
    );
  });

  it('reads directory and packDir from the artifact', async () => {
    await buildSite('app/dist/browser');
    const handler = getDeployMethod('static-site', 'gh-pages')!;
    const c = siteCtx('singleton', { directory: 'app', packDir: 'dist/browser' });
    await handler.copyFiles(c);
    expect(existsSync(join(dir, 'out', 'site', 'index.html'))).toBe(true);
  });

  it('fails with a hint when the site was never built', async () => {
    const handler = getDeployMethod('static-site', 'gh-pages')!;
    await expect(handler.copyFiles(siteCtx())).rejects.toThrow(/built site not found/);
  });

  it('supplies the site when an override folder only brought its own files', async () => {
    await buildSite('dist');
    const handler = getDeployMethod('static-site', 'gh-pages')!;
    const c = siteCtx();
    await mkdir(c.deployOutputDir, { recursive: true });
    await writeFile(join(c.deployOutputDir, 'CNAME'), 'example.com');
    await handler.generateDeployYml(c);
    expect(existsSync(join(dir, 'out', 'site', 'index.html'))).toBe(true);
  });
});

describe('pagesSlotPath', () => {
  it('is the deployment slot as a path', () => {
    expect(pagesSlotPath('@org/site', '2.3.5', 'singleton', false)).toBe('org-site');
    expect(pagesSlotPath('@org/site', '2.3.5', 'major', false)).toBe('org-site/v2');
    expect(pagesSlotPath('plain', '1.0.0', undefined, false)).toBe('plain');
    expect(pagesSlotPath('@org/site', '2.3.5', 'singleton', true)).toBe('');
  });
});
