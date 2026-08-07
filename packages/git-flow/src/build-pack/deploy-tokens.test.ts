import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderDeployTemplates, deployContext } from './execute.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deploy-tokens-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// deployContext
// ---------------------------------------------------------------------------

describe('deployContext', () => {
  it('singleton: SERVICE and SERVICE_ID are both the base name', () => {
    const t = deployContext('@org/my-svc', '1.2.3', 'singleton');
    expect(t['SERVICE']).toBe('org-my-svc');
    expect(t['SERVICE_ID']).toBe('org-my-svc');
    expect(t['STACK']).toBe('org_my_svc');
    expect(t['VERSION']).toBe('1.2.3');
    expect(t['MAJOR']).toBe('1');
  });

  it('major: SERVICE_ID includes -v<major>, SERVICE stays unversioned', () => {
    const t = deployContext('@org/my-svc', '2.5.0', 'major');
    expect(t['SERVICE']).toBe('org-my-svc');
    expect(t['SERVICE_ID']).toBe('org-my-svc-v2');
    expect(t['STACK']).toBe('org_my_svc_v2'); // default: slotStack(SERVICE_ID)
    expect(t['MAJOR']).toBe('2');
  });

  it('stackOverride replaces STACK without affecting SERVICE_ID', () => {
    const t = deployContext('@org/my-svc', '1.0.0', 'singleton', 'webservices');
    expect(t['SERVICE_ID']).toBe('org-my-svc');
    expect(t['STACK']).toBe('webservices');
  });
});

// ---------------------------------------------------------------------------
// renderDeployTemplates
// ---------------------------------------------------------------------------

describe('renderDeployTemplates', () => {
  it('renders values in text files', async () => {
    await writeFile(
      join(dir, 'stack.yml'),
      'services:\n  @{ SERVICE_ID }:\n    image: app:${DEPLOY_IMAGE_TAG}\n',
    );
    await renderDeployTemplates(dir, { SERVICE_ID: 'my-svc-v2' });
    const result = await readFile(join(dir, 'stack.yml'), 'utf-8');
    expect(result).toBe('services:\n  my-svc-v2:\n    image: app:${DEPLOY_IMAGE_TAG}\n');
  });

  it('leaves ${VAR} runtime interpolation untouched', async () => {
    await writeFile(join(dir, 'test.yml'), 'image: ${DEPLOY_IMAGE_TAG}\nstack: @{ STACK }\n');
    await renderDeployTemplates(dir, { STACK: 'webservices' });
    const result = await readFile(join(dir, 'test.yml'), 'utf-8');
    expect(result).toBe('image: ${DEPLOY_IMAGE_TAG}\nstack: webservices\n');
  });

  it('renders multiple values in a single file', async () => {
    await writeFile(
      join(dir, 'deploy.yml'),
      'deployCommand: docker stack deploy -c stack.yml @{ STACK }\nteardownCommand: docker stack rm @{ STACK }\nservice: @{ SERVICE_ID }\n',
    );
    await renderDeployTemplates(dir, { STACK: 'my_stack', SERVICE_ID: 'my-svc-v1' });
    const result = await readFile(join(dir, 'deploy.yml'), 'utf-8');
    expect(result).toContain('docker stack deploy -c stack.yml my_stack');
    expect(result).toContain('docker stack rm my_stack');
    expect(result).toContain('service: my-svc-v1');
  });

  it('recurses into subdirectories', async () => {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'config.yml'), 'name: @{ SERVICE }\n');
    await renderDeployTemplates(dir, { SERVICE: 'my-svc' });
    const result = await readFile(join(dir, 'sub', 'config.yml'), 'utf-8');
    expect(result).toBe('name: my-svc\n');
  });

  it('leaves files that contain no template syntax unchanged', async () => {
    const content = 'no placeholders here\n';
    await writeFile(join(dir, 'plain.yml'), content);
    await renderDeployTemplates(dir, { SERVICE: 'my-svc' });
    expect(await readFile(join(dir, 'plain.yml'), 'utf-8')).toBe(content);
  });

  it('throws on an undefined value instead of emitting an empty string', async () => {
    await writeFile(join(dir, 'stack.yml'), 'name: @{ NOPE }\n');
    await expect(renderDeployTemplates(dir, { SERVICE: 'my-svc' })).rejects.toThrow('stack.yml');
  });

  it('hashes a sibling file so the value only changes when its content does', async () => {
    await mkdir(join(dir, 'config'));
    await writeFile(join(dir, 'config', 'appsettings.yml'), 'key: value\n');
    await writeFile(
      join(dir, 'stack.yml'),
      "name: cfg_@{ shortHash(file('config/appsettings.yml')) }\n",
    );
    await renderDeployTemplates(dir, {});
    const first = await readFile(join(dir, 'stack.yml'), 'utf-8');
    expect(first).toMatch(/^name: cfg_[0-9a-f]{12}\n$/);

    // Same content re-packed → same name (no churn).
    await writeFile(
      join(dir, 'stack.yml'),
      "name: cfg_@{ shortHash(file('config/appsettings.yml')) }\n",
    );
    await renderDeployTemplates(dir, {});
    expect(await readFile(join(dir, 'stack.yml'), 'utf-8')).toBe(first);

    // Changed content → different name.
    await writeFile(join(dir, 'config', 'appsettings.yml'), 'key: other\n');
    await writeFile(
      join(dir, 'stack.yml'),
      "name: cfg_@{ shortHash(file('config/appsettings.yml')) }\n",
    );
    await renderDeployTemplates(dir, {});
    expect(await readFile(join(dir, 'stack.yml'), 'utf-8')).not.toBe(first);
  });

  it('hashes the RENDERED content of a sibling, not its raw source', async () => {
    await mkdir(join(dir, 'config'));
    await writeFile(join(dir, 'config', 'app.yml'), 'service: @{ SERVICE }\n');
    await writeFile(join(dir, 'stack.yml'), "name: @{ sha256(file('config/app.yml')) }\n");
    await renderDeployTemplates(dir, { SERVICE: 'my-svc' });
    // The sibling is rendered exactly once, and its rendered form is what shipped.
    expect(await readFile(join(dir, 'config', 'app.yml'), 'utf-8')).toBe('service: my-svc\n');
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update('service: my-svc\n').digest('hex');
    expect(await readFile(join(dir, 'stack.yml'), 'utf-8')).toBe(`name: ${expected}\n`);
  });

  it('rejects a file() path that escapes the bundle', async () => {
    await writeFile(join(dir, 'stack.yml'), "name: @{ file('../outside.yml') }\n");
    await expect(renderDeployTemplates(dir, {})).rejects.toThrow();
  });

  it('supports loops for repeated blocks', async () => {
    await writeFile(
      join(dir, 'stack.yml'),
      'configs:\n@% for e in ["dev", "prod"] %@  cfg_@{ e }: {}\n@% endfor %@',
    );
    await renderDeployTemplates(dir, {});
    const result = await readFile(join(dir, 'stack.yml'), 'utf-8');
    expect(result).toContain('cfg_dev: {}');
    expect(result).toContain('cfg_prod: {}');
  });
});
