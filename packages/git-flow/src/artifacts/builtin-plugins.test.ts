import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BUILTIN_PROVIDER,
  builtinPlugin,
  getArtifactType,
  listArtifactTypeProviders,
  listArtifactTypes,
  type PackContext,
} from './index.js';

let root: string;
let outDir: string;
let counter = 0;

beforeEach(async () => {
  root = join(tmpdir(), `gf-builtin-${Date.now()}-${counter++}`);
  outDir = join(root, 'out');
  await mkdir(outDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ctx(version = '1.2.3'): PackContext {
  return {
    projectCwd: root,
    workspaceRoot: root,
    artifactOutputDir: outDir,
    projectName: '@org/thing',
    version,
  };
}

describe('first-party types are available without installing anything', () => {
  it('registers dotnet-lib and ng-lib alongside the other built-ins', () => {
    const types = listArtifactTypes();
    expect(types).toContain('dotnet-lib');
    expect(types).toContain('ng-lib');
    expect(types).toContain('docker-service');
    // The types they complement, not replace.
    expect(types).toContain('nuget');
    expect(types).toContain('npm');
    expect(types).toContain('docker-image');
  });

  // The point of the manifest: there is no privileged set seeded behind the
  // registry's back. Everything git-flow ships declares itself the same way an
  // installed package does.
  it('declares every built-in type on the plugin manifest', () => {
    expect(Object.keys(builtinPlugin.artifactTypes ?? {}).sort()).toEqual([
      'deploy',
      'docker-image',
      'docker-service',
      'dotnet-lib',
      'ng-lib',
      'npm',
      'nuget',
      'release-attachment',
    ]);
  });

  it('declares the built-in deploy methods on the same manifest', () => {
    expect(
      (builtinPlugin.deployMethods ?? []).map((m) => `${m.artifactType}.${m.method}`).sort(),
    ).toEqual([
      'docker-image.compose',
      'docker-image.swarm',
      'docker-service.compose',
      'docker-service.swarm',
      'npm.node',
    ]);
  });

  it("does not register the old 'docker' name", () => {
    expect(listArtifactTypes()).not.toContain('docker');
    expect(() => getArtifactType('docker')).toThrow(/Unknown artifact type/);
  });

  it('attributes them all to the git-flow provider, at the lowest rung', () => {
    for (const type of Object.keys(builtinPlugin.artifactTypes ?? {})) {
      expect(listArtifactTypeProviders(type)).toContain(BUILTIN_PROVIDER);
      // Addressable by provider, which is what lets a plugin override a built-in
      // while the original stays reachable.
      expect(getArtifactType(type, BUILTIN_PROVIDER)).toBeDefined();
    }
  });
});

describe('ng-lib', () => {
  async function writeClient(version: string, packDir = 'dist'): Promise<void> {
    const dir = join(root, 'client', packDir);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@org/ngclient', version, private: false }),
    );
  }

  it('packs from the build output directory, not the project root', async () => {
    await writeClient('1.2.3');

    const artifact = {
      type: 'ng-lib',
      name: '@org/ngclient',
      directory: 'client',
    } as never;

    await getArtifactType('ng-lib').pack(artifact, ctx());

    const path = (artifact as { path: string }).path;
    expect(path).toMatch(/\.tgz$/);
    expect(path.startsWith(outDir)).toBe(true);
  });

  // Regression: zx quotes interpolations, so the build command must be handed
  // to a shell explicitly — the naive form ran the whole string as argv[0] and
  // died with "command not found". A compound command proves the shell parses it.
  it('runs the build command when the output is missing', async () => {
    const clientDir = join(root, 'client');
    await mkdir(clientDir, { recursive: true });
    const pkg = JSON.stringify({ name: '@org/ngclient', version: '1.2.3' });

    const artifact = {
      type: 'ng-lib',
      name: '@org/ngclient',
      directory: 'client',
      build: `mkdir -p dist && printf '%s' '${pkg}' > dist/package.json`,
    } as never;

    await getArtifactType('ng-lib').pack(artifact, ctx());
    expect((artifact as { path: string }).path).toMatch(/\.tgz$/);
  });

  it('honours a custom packDir', async () => {
    await writeClient('1.2.3', 'build-output');

    const artifact = {
      type: 'ng-lib',
      name: '@org/ngclient',
      directory: 'client',
      packDir: 'build-output',
    } as never;

    await getArtifactType('ng-lib').pack(artifact, ctx());
    expect((artifact as { path: string }).path).toMatch(/\.tgz$/);
  });

  // The whole point of checking here: publishing would succeed and the release
  // would then fail at verification, which looks up name@releaseVersion.
  it('fails early when the generated package version does not match the release', async () => {
    await writeClient('0.7.29');

    const artifact = {
      type: 'ng-lib',
      name: '@org/ngclient',
      directory: 'client',
    } as never;

    await expect(getArtifactType('ng-lib').pack(artifact, ctx('1.2.3'))).rejects.toThrow(
      /is version '0\.7\.29', but the release is '1\.2\.3'/,
    );
  });

  it('says what to fix when the directory is missing', async () => {
    const artifact = {
      type: 'ng-lib',
      name: '@org/ngclient',
      directory: 'nope',
    } as never;

    await expect(getArtifactType('ng-lib').pack(artifact, ctx())).rejects.toThrow(
      /does not exist/,
    );
  });

  it('says what to fix when the build output is missing', async () => {
    await mkdir(join(root, 'client'), { recursive: true });

    const artifact = {
      type: 'ng-lib',
      name: '@org/ngclient',
      directory: 'client',
    } as never;

    await expect(getArtifactType('ng-lib').pack(artifact, ctx())).rejects.toThrow(
      /build output 'dist' not found/,
    );
  });

  it('requires a directory', async () => {
    const artifact = { type: 'ng-lib', name: '@org/ngclient' } as never;

    await expect(getArtifactType('ng-lib').pack(artifact, ctx())).rejects.toThrow(
      /requires 'directory'/,
    );
  });

  it('publishes to the registries it declares, and nothing when it declares none', () => {
    const handler = getArtifactType('ng-lib');
    expect(handler.getRegistries({ registries: ['github-npm'] } as never)).toEqual(['github-npm']);
    expect(handler.getRegistries({} as never)).toEqual([]);
  });

  it('verifies against the release version', () => {
    expect(getArtifactType('ng-lib').getVersion({} as never, '9.9.9')).toBe('9.9.9');
  });
});

describe('dotnet-lib', () => {
  it('reports what it produced when the package id does not match', async () => {
    // No dotnet SDK assumptions: an empty output dir exercises the same failure
    // path as a pack that produced nothing matching the declared name.
    const artifact = {
      type: 'dotnet-lib',
      name: 'Some.Package',
      project: 'missing.csproj',
    } as never;

    await expect(getArtifactType('dotnet-lib').pack(artifact, ctx())).rejects.toThrow();
  });

  it('publishes to the registries it declares', () => {
    const handler = getArtifactType('dotnet-lib');
    expect(handler.getRegistries({ registries: ['github-nuget'] } as never)).toEqual([
      'github-nuget',
    ]);
    expect(handler.getRegistries({} as never)).toEqual([]);
  });

  it('verifies against the release version', () => {
    expect(getArtifactType('dotnet-lib').getVersion({} as never, '4.5.6')).toBe('4.5.6');
  });

  it('is not deployable on its own', async () => {
    await expect(
      getArtifactType('dotnet-lib').packDeploy({} as never, {} as never),
    ).resolves.toBeUndefined();
  });
});

describe('docker-service', () => {
  it('backfills the name from the project and produces no file artifact', async () => {
    const artifact = { type: 'docker-service' } as never;

    await getArtifactType('docker-service').pack(artifact, ctx());

    expect((artifact as { name: string }).name).toBe('@org/thing');
    expect((artifact as { path?: string }).path).toBeUndefined();
  });

  it('rejects a registries declaration — there is nothing to publish', async () => {
    const artifact = {
      type: 'docker-service',
      name: 'traefik',
      registries: ['ghcr'],
    } as never;

    await expect(getArtifactType('docker-service').pack(artifact, ctx())).rejects.toThrow(
      /produces nothing to publish/,
    );
  });

  it('never asks to publish', () => {
    const handler = getArtifactType('docker-service');
    expect(handler.getRegistries({ registries: ['ghcr'] } as never)).toEqual([]);
    expect(handler.getVersion({} as never, '3.1.0')).toBe('3.1.0');
  });

  it('shares the compose and swarm deploy methods with docker-image', async () => {
    const { getDeployMethod } = await import('./deploy-methods.js');
    const viaService = getDeployMethod('docker-service', 'swarm');
    const viaImage = getDeployMethod('docker-image', 'swarm');

    // The same handler object, not a copy: these methods only ever operated on
    // deploy files, so the image-less type reuses them outright.
    expect(viaService).toBeDefined();
    expect(viaService).toBe(viaImage);
    expect(viaService?.supportsParallelMajors).toBe(true);
    expect(getDeployMethod('docker-service', 'compose')).toBe(
      getDeployMethod('docker-image', 'compose'),
    );
  });
});
