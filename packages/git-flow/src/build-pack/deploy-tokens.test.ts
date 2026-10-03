import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderDeployTemplates,
  deployContext,
  globToRegExp,
  hasTemplateMarkers,
} from './execute.js';

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
  it('singleton: SERVICE/SERVICE_ID are the unscoped name, STACK is the scope', () => {
    const t = deployContext('@org/my-svc', '1.2.3', 'singleton');
    expect(t['SERVICE']).toBe('my-svc');
    expect(t['SERVICE_ID']).toBe('my-svc');
    expect(t['STACK']).toBe('org');
    expect(t['VERSION']).toBe('1.2.3');
    expect(t['MAJOR']).toBe('1');
  });

  it('major: SERVICE_ID gets _v<major>, SERVICE stays unversioned', () => {
    const t = deployContext('@org/my-svc', '2.5.0', 'major');
    expect(t['SERVICE']).toBe('my-svc');
    expect(t['SERVICE_ID']).toBe('my-svc_v2');
    expect(t['STACK']).toBe('org');
    expect(t['MAJOR']).toBe('2');
  });

  it('unscoped package: STACK falls back to SERVICE', () => {
    const t = deployContext('my-svc', '1.0.0', 'singleton');
    expect(t['SERVICE']).toBe('my-svc');
    expect(t['STACK']).toBe('my-svc');
  });

  it('stackOverride replaces STACK without affecting SERVICE_ID', () => {
    const t = deployContext('@org/my-svc', '1.0.0', 'singleton', 'webservices');
    expect(t['SERVICE_ID']).toBe('my-svc');
    expect(t['STACK']).toBe('webservices');
  });

  it('serviceOverride replaces SERVICE and the SERVICE_ID base', () => {
    const t = deployContext('@org/my-svc', '2.0.0', 'major', undefined, 'custom');
    expect(t['SERVICE']).toBe('custom');
    expect(t['SERVICE_ID']).toBe('custom_v2');
    expect(t['STACK']).toBe('org');
  });

  it('STACK_SERVICE_ID is docker’s service name; STACK_SERVICE is its unversioned twin', () => {
    const t = deployContext('@org/my-svc', '2.5.0', 'major', 'webservice');
    expect(t['STACK_SERVICE_ID']).toBe('webservice_my-svc_v2');
    expect(t['STACK_SERVICE']).toBe('webservice_my-svc');
    expect(t['SERVICE_NAME']).toBeUndefined();
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

// ---------------------------------------------------------------------------
// templateIgnore
// ---------------------------------------------------------------------------

describe('renderDeployTemplates ignore', () => {
  it('leaves ignored paths alone even when they look like templates', async () => {
    await mkdir(join(dir, 'site', 'chunks'), { recursive: true });
    const chunk = 'x="@{ NOT_A_TOKEN }"';
    await writeFile(join(dir, 'site', 'chunks', 'a.js'), chunk);
    await writeFile(join(dir, 'deploy.yml'), 'service: @{ SERVICE }\n');

    await renderDeployTemplates(dir, { SERVICE: 'svc' }, ['site/**']);

    expect(await readFile(join(dir, 'site', 'chunks', 'a.js'), 'utf-8')).toBe(chunk);
    expect(await readFile(join(dir, 'deploy.yml'), 'utf-8')).toBe('service: svc\n');
  });

  it('would otherwise fail on the same content', async () => {
    await mkdir(join(dir, 'site'));
    await writeFile(join(dir, 'site', 'a.js'), 'x="@{ NOT_A_TOKEN }"');
    await expect(renderDeployTemplates(dir, {})).rejects.toThrow('site/a.js');
  });

  it('matches single-segment wildcards within one directory only', async () => {
    await mkdir(join(dir, 'vendor', 'deep'), { recursive: true });
    await writeFile(join(dir, 'vendor', 'x.js'), '@{ NOPE }');
    await writeFile(join(dir, 'vendor', 'deep', 'y.js'), '@{ NOPE }');

    await expect(renderDeployTemplates(dir, {}, ['vendor/*.js'])).rejects.toThrow(
      'vendor/deep/y.js',
    );
  });
});

describe('globToRegExp', () => {
  it('** spans directories, * and ? do not', () => {
    expect(globToRegExp('site/**').test('site/a.js')).toBe(true);
    expect(globToRegExp('site/**').test('site/deep/er/a.js')).toBe(true);
    expect(globToRegExp('site/**').test('sites/a.js')).toBe(false);
    expect(globToRegExp('**/*.min.js').test('a.min.js')).toBe(true);
    expect(globToRegExp('**/*.min.js').test('x/y/a.min.js')).toBe(true);
    expect(globToRegExp('*.js').test('a.js')).toBe(true);
    expect(globToRegExp('*.js').test('x/a.js')).toBe(false);
    expect(globToRegExp('a?.js').test('ab.js')).toBe(true);
    expect(globToRegExp('a?.js').test('a/.js')).toBe(false);
  });

  it('treats regex metacharacters literally', () => {
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
    expect(globToRegExp('a.b').test('aXb')).toBe(false);
    expect(globToRegExp('(x)').test('(x)')).toBe(true);
  });
});

describe('hasTemplateMarkers', () => {
  it('detects each delimiter and nothing else', () => {
    expect(hasTemplateMarkers('plain ${VAR} {{ jinja }}')).toBe(false);
    expect(hasTemplateMarkers('a @{ X }')).toBe(true);
    expect(hasTemplateMarkers('@% if x %@')).toBe(true);
    expect(hasTemplateMarkers('@# note #@')).toBe(true);
  });
});
