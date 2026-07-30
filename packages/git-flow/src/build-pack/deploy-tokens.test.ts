import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { substituteDeployTokens, deployTokens } from './execute.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deploy-tokens-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// deployTokens
// ---------------------------------------------------------------------------

describe('deployTokens', () => {
  it('singleton: SERVICE and SERVICE_ID are both the base name', () => {
    const t = deployTokens('@org/my-svc', '1.2.3', 'singleton');
    expect(t['SERVICE']).toBe('org-my-svc');
    expect(t['SERVICE_ID']).toBe('org-my-svc');
    expect(t['STACK']).toBe('org_my_svc');
    expect(t['VERSION']).toBe('1.2.3');
    expect(t['MAJOR']).toBe('1');
  });

  it('major: SERVICE_ID includes -v<major>, SERVICE stays unversioned', () => {
    const t = deployTokens('@org/my-svc', '2.5.0', 'major');
    expect(t['SERVICE']).toBe('org-my-svc');
    expect(t['SERVICE_ID']).toBe('org-my-svc-v2');
    expect(t['STACK']).toBe('org_my_svc_v2'); // default: slotStack(SERVICE_ID)
    expect(t['MAJOR']).toBe('2');
  });

  it('stackOverride replaces STACK without affecting SERVICE_ID', () => {
    const t = deployTokens('@org/my-svc', '1.0.0', 'singleton', 'webservices');
    expect(t['SERVICE_ID']).toBe('org-my-svc');
    expect(t['STACK']).toBe('webservices');
  });
});

// ---------------------------------------------------------------------------
// substituteDeployTokens
// ---------------------------------------------------------------------------

describe('substituteDeployTokens', () => {
  it('replaces tokens in text files', async () => {
    await writeFile(
      join(dir, 'stack.yml'),
      'services:\n  __SERVICE_ID__:\n    image: app:${DEPLOY_IMAGE_TAG}\n',
    );
    await substituteDeployTokens(dir, { SERVICE_ID: 'my-svc-v2' });
    const result = await readFile(join(dir, 'stack.yml'), 'utf-8');
    expect(result).toBe('services:\n  my-svc-v2:\n    image: app:${DEPLOY_IMAGE_TAG}\n');
  });

  it('leaves ${VAR} runtime interpolation untouched', async () => {
    await writeFile(join(dir, 'test.yml'), 'image: ${DEPLOY_IMAGE_TAG}\nstack: __STACK__\n');
    await substituteDeployTokens(dir, { STACK: 'webservices' });
    const result = await readFile(join(dir, 'test.yml'), 'utf-8');
    expect(result).toBe('image: ${DEPLOY_IMAGE_TAG}\nstack: webservices\n');
  });

  it('replaces multiple tokens in a single file', async () => {
    await writeFile(
      join(dir, 'deploy.yml'),
      'deployCommand: docker stack deploy -c stack.yml __STACK__\nteardownCommand: docker stack rm __STACK__\nservice: __SERVICE_ID__\n',
    );
    await substituteDeployTokens(dir, { STACK: 'my_stack', SERVICE_ID: 'my-svc-v1' });
    const result = await readFile(join(dir, 'deploy.yml'), 'utf-8');
    expect(result).toContain('docker stack deploy -c stack.yml my_stack');
    expect(result).toContain('docker stack rm my_stack');
    expect(result).toContain('service: my-svc-v1');
  });

  it('recurses into subdirectories', async () => {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'config.yml'), 'name: __SERVICE__\n');
    await substituteDeployTokens(dir, { SERVICE: 'my-svc' });
    const result = await readFile(join(dir, 'sub', 'config.yml'), 'utf-8');
    expect(result).toBe('name: my-svc\n');
  });

  it('skips files that need no substitution', async () => {
    const content = 'no tokens here\n';
    await writeFile(join(dir, 'plain.yml'), content);
    await substituteDeployTokens(dir, { SERVICE: 'my-svc' });
    // File unchanged — content identical
    expect(await readFile(join(dir, 'plain.yml'), 'utf-8')).toBe(content);
  });
});
