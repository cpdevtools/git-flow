import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findWorkspaceRoot, loadPlugins } from './load-plugins.js';
import { getArtifactType, listArtifactTypes, registerArtifactType } from './index.js';
import { getDeployMethod } from './deploy-methods.js';

let root: string;
let counter = 0;

/**
 * Write a plugin package into node_modules the way an install would.
 *
 * Deliberately CommonJS and importing nothing: a real plugin must not import
 * git-flow at runtime, because the copy it would resolve is not the copy doing
 * the dispatching. These fixtures prove registration works under that rule.
 */
async function installPlugin(
  dir: string,
  name: string,
  body: string,
  manifestExtra: Record<string, unknown> = {},
): Promise<void> {
  const pkgDir = join(dir, 'node_modules', ...name.split('/'));
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', main: 'index.cjs', ...manifestExtra }),
  );
  await writeFile(join(pkgDir, 'index.cjs'), body);
}

function handlerSource(label: string): string {
  return `
    const handler = {
      async pack(artifact) { artifact.path = ${JSON.stringify(label)}; },
      async packDeploy() {},
      async upload() {},
      async publish() {},
      getRegistries(a) { return a.registries ?? []; },
      getVersion(_, v) { return v; },
    };
  `;
}

async function writeManifest(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
}

beforeEach(async () => {
  root = join(tmpdir(), `gf-plugins-${Date.now()}-${counter++}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'projects/*'\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('findWorkspaceRoot', () => {
  it('walks up to the directory owning pnpm-workspace.yaml', async () => {
    const project = join(root, 'projects', 'api');
    await mkdir(project, { recursive: true });
    expect(await findWorkspaceRoot(project)).toBe(root);
  });

  it('falls back to the starting directory when there is no workspace above', async () => {
    const solo = join(tmpdir(), `gf-solo-${Date.now()}`);
    await mkdir(solo, { recursive: true });
    expect(await findWorkspaceRoot(solo)).toBe(solo);
    await rm(solo, { recursive: true, force: true });
  });
});

describe('loadPlugins discovery', () => {
  it('enables a plugin by installation alone, with no config entry', async () => {
    const name = '@org/git-flow-plugin-by-name';
    await writeManifest(root, { name: 'root', devDependencies: { [name]: '1.0.0' } });
    await installPlugin(
      root,
      name,
      `${handlerSource('by-name')}
       module.exports = { name: ${JSON.stringify(name)}, artifactTypes: { 'by-name': handler } };`,
    );

    const loaded = await loadPlugins({ workspaceRoot: root });

    expect(loaded.map((p) => p.name)).toContain(name);
    expect(listArtifactTypes()).toContain('by-name');
  });

  it('discovers a package that opts in with a gitflow key despite its name', async () => {
    const name = '@org/oddly-named';
    await writeManifest(root, { name: 'root', devDependencies: { [name]: '1.0.0' } });
    await installPlugin(
      root,
      name,
      `${handlerSource('by-key')}
       module.exports = { name: ${JSON.stringify(name)}, artifactTypes: { 'by-key': handler } };`,
      { gitflow: { plugin: true } },
    );

    await loadPlugins({ workspaceRoot: root });

    expect(listArtifactTypes()).toContain('by-key');
  });

  it('ignores an ordinary dependency', async () => {
    await writeManifest(root, { name: 'root', devDependencies: { lodash: '4.0.0' } });
    await installPlugin(root, 'lodash', 'module.exports = {};');

    const loaded = await loadPlugins({ workspaceRoot: root });

    expect(loaded).toHaveLength(0);
  });

  it('skips a declared-but-uninstalled plugin instead of failing the build', async () => {
    await writeManifest(root, {
      name: 'root',
      devDependencies: { '@org/git-flow-plugin-absent': '1.0.0' },
    });

    await expect(loadPlugins({ workspaceRoot: root })).resolves.toEqual([]);
  });

  it('registers deploy methods scoped to their artifact type', async () => {
    const name = '@org/git-flow-plugin-k8s';
    await writeManifest(root, { name: 'root', devDependencies: { [name]: '1.0.0' } });
    await installPlugin(
      root,
      name,
      `module.exports = {
         name: ${JSON.stringify(name)},
         deployMethods: [{
           artifactType: 'docker-image',
           method: 'k8s-test',
           handler: { async copyFiles() {}, async generateDeployYml() {} },
         }],
       };`,
    );

    await loadPlugins({ workspaceRoot: root });

    expect(getDeployMethod('docker-image', 'k8s-test')).toBeDefined();
    // Scoped, not global — the same method name on another type is unrelated.
    expect(getDeployMethod('npm', 'k8s-test')).toBeUndefined();
  });

  it('supports the register() hook, which receives the API by argument', async () => {
    const name = '@org/git-flow-plugin-dynamic';
    await writeManifest(root, { name: 'root', devDependencies: { [name]: '1.0.0' } });
    await installPlugin(
      root,
      name,
      `${handlerSource('dynamic')}
       module.exports = {
         name: ${JSON.stringify(name)},
         register(api) { api.registerArtifactType('dynamic-type', handler); },
       };`,
    );

    await loadPlugins({ workspaceRoot: root });

    expect(listArtifactTypes()).toContain('dynamic-type');
  });

  // Regression for the silent-skip bug: an exports map that does not list
  // ./package.json makes require.resolve(pkg + '/package.json') throw for a
  // healthy, importable package — which the old code classified as "not
  // installed" and dropped without a word.
  it('loads a plugin whose exports map hides its package.json', async () => {
    const name = '@org/git-flow-plugin-strict-exports';
    await writeManifest(root, { name: 'root', devDependencies: { [name]: '1.0.0' } });
    await installPlugin(
      root,
      name,
      `${handlerSource('strict')}
       module.exports = { name: ${JSON.stringify(name)}, artifactTypes: { 'strict-exports': handler } };`,
      { exports: { '.': './index.cjs' } },
    );

    const loaded = await loadPlugins({ workspaceRoot: root });

    expect(loaded.map((p) => p.name)).toContain(name);
    expect(loaded.find((p) => p.name === name)?.version).toBe('1.0.0');
    expect(listArtifactTypes()).toContain('strict-exports');
  });

  it('discovers a gitflow-key opt-in behind a strict exports map', async () => {
    const name = '@org/quiet-package';
    await writeManifest(root, { name: 'root', devDependencies: { [name]: '1.0.0' } });
    await installPlugin(
      root,
      name,
      `${handlerSource('quiet')}
       module.exports = { name: ${JSON.stringify(name)}, artifactTypes: { 'quiet-type': handler } };`,
      { exports: { '.': './index.cjs' }, gitflow: { plugin: true } },
    );

    await loadPlugins({ workspaceRoot: root });

    expect(listArtifactTypes()).toContain('quiet-type');
  });

  // Dual-format packages plant bare {"type":"commonjs"} stubs next to their
  // built output; the walk-up must keep going to the manifest that names the
  // package instead of stopping at the stub.
  it('walks past a dist-stub package.json to the real manifest', async () => {
    const name = '@org/git-flow-plugin-stubbed';
    await writeManifest(root, { name: 'root', devDependencies: { [name]: '1.0.0' } });

    const pkgDir = join(root, 'node_modules', ...name.split('/'));
    await mkdir(join(pkgDir, 'dist'), { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name, version: '2.5.0', main: 'dist/index.cjs' }),
    );
    await writeFile(join(pkgDir, 'dist', 'package.json'), JSON.stringify({ type: 'commonjs' }));
    await writeFile(
      join(pkgDir, 'dist', 'index.cjs'),
      `${handlerSource('stubbed')}
       module.exports = { name: ${JSON.stringify(name)}, artifactTypes: { 'stubbed-type': handler } };`,
    );

    const loaded = await loadPlugins({ workspaceRoot: root });

    // Version must come from the real manifest, not the stub (which has none).
    expect(loaded.find((p) => p.name === name)?.version).toBe('2.5.0');
    expect(listArtifactTypes()).toContain('stubbed-type');
  });

  it('rejects a package that looks like a plugin but exports something else', async () => {
    const name = '@org/git-flow-plugin-broken';
    await writeManifest(root, { name: 'root', devDependencies: { [name]: '1.0.0' } });
    await installPlugin(root, name, 'module.exports = 42;');

    await expect(loadPlugins({ workspaceRoot: root })).rejects.toThrow(/not a plugin manifest/);
  });
});

describe('loadPlugins precedence', () => {
  it('a project-level plugin outranks a workspace-level one supplying the same type', async () => {
    const type = `ladder-${Date.now()}`;
    const project = join(root, 'projects', 'api');

    await writeManifest(root, {
      name: 'root',
      devDependencies: { '@org/git-flow-plugin-ws': '1.0.0' },
    });
    await installPlugin(
      root,
      '@org/git-flow-plugin-ws',
      `${handlerSource('workspace-wins')}
       module.exports = { name: '@org/git-flow-plugin-ws', artifactTypes: { ${JSON.stringify(type)}: handler } };`,
    );

    await writeManifest(project, {
      name: 'api',
      devDependencies: { '@org/git-flow-plugin-proj': '1.0.0' },
    });
    await installPlugin(
      project,
      '@org/git-flow-plugin-proj',
      `${handlerSource('project-wins')}
       module.exports = { name: '@org/git-flow-plugin-proj', artifactTypes: { ${JSON.stringify(type)}: handler } };`,
    );

    await loadPlugins({ workspaceRoot: root, projectCwd: project });

    const artifact = { type, name: 'x' } as never;
    await getArtifactType(type).pack(artifact, {} as never);
    expect((artifact as { path: string }).path).toBe('project-wins');
  });

  it('an installed plugin overrides a built-in type', async () => {
    const name = '@org/git-flow-plugin-override';
    await writeManifest(root, { name: 'root', devDependencies: { [name]: '1.0.0' } });
    await installPlugin(
      root,
      name,
      `${handlerSource('overridden')}
       module.exports = { name: ${JSON.stringify(name)}, artifactTypes: { 'release-attachment': handler } };`,
    );

    await loadPlugins({ workspaceRoot: root });

    const artifact = { type: 'release-attachment', name: 'x' } as never;
    await getArtifactType('release-attachment').pack(artifact, {} as never);
    expect((artifact as { path: string }).path).toBe('overridden');

    // The built-in is still addressable by name.
    expect(getArtifactType('release-attachment', '@cpdevtools/git-flow')).toBeDefined();
  });
});

describe('artifact type resolution', () => {
  it('names the registered types when one is unknown', () => {
    expect(() => getArtifactType('nope')).toThrow(/Registered types:/);
  });

  it('two plugins supplying one type conflict until an artifact pins a provider', async () => {
    const type = `conflict-${Date.now()}`;

    const stub = {
      async pack() {},
      async packDeploy() {},
      async upload() {},
      async publish() {},
      getRegistries: () => [],
      getVersion: (_: unknown, v: string) => v,
    };

    registerArtifactType(type, stub as never, '@org/first', 'workspace');
    registerArtifactType(type, stub as never, '@org/second', 'workspace');

    expect(() => getArtifactType(type)).toThrow(/supplied by more than one plugin/);
    expect(getArtifactType(type, '@org/second')).toBeDefined();
  });
});
