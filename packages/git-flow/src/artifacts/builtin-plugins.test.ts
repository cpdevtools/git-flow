import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getArtifactType, listArtifactTypes, type PackContext } from './index.js';

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
    // The types they complement, not replace.
    expect(types).toContain('nuget');
    expect(types).toContain('npm');
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
