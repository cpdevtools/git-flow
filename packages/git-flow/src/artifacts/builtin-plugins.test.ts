import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { buildPe, buildVersionInfo } from './pe-version.fixture.js';
import { executableAssetName, normalizeBinaryVersion } from './builtin-plugins.js';
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
      'executable',
      'ng-lib',
      'npm',
      'nuget',
      'release-attachment',
      'static-site',
    ]);
  });

  it('declares the built-in deploy methods on the same manifest', () => {
    expect(
      (builtinPlugin.deployMethods ?? []).map((m) => `${m.artifactType}.${m.method}`).sort(),
    ).toEqual([
      'docker-image.compose',
      'docker-image.swarm',
      'docker-image.swarm-job',
      'docker-service.compose',
      'docker-service.swarm',
      'docker-service.swarm-job',
      'npm.node',
      'static-site.gh-pages',
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

// ng-lib and dotnet-lib pack tests shell out to real tooling (pnpm pack,
// dotnet build/pack). On a cold CI runner the first dotnet invocation pays
// NuGet restore + SDK warm-up, which regularly blows vitest's default 5s
// per-test budget — the timeout here only guards against hangs, it is not a
// performance assertion.
const SUBPROCESS_TIMEOUT = 120_000;

describe('ng-lib', { timeout: SUBPROCESS_TIMEOUT }, () => {
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

  // Building is the project's job (github.actions.build runs before pack), so a
  // leftover `build:` key from an older config must be inert — pack verifies and
  // packs, it never executes config-supplied commands.
  it('ignores a build command instead of executing it', async () => {
    await writeClient('1.2.3');

    const artifact = {
      type: 'ng-lib',
      name: '@org/ngclient',
      directory: 'client',
      build: 'exit 1', // would fail the pack if it were ever run
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

    await expect(getArtifactType('ng-lib').pack(artifact, ctx())).rejects.toThrow(/does not exist/);
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

describe('dotnet-lib', { timeout: SUBPROCESS_TIMEOUT }, () => {
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

describe('static-site', () => {
  async function buildSite(sub = 'dist'): Promise<string> {
    const siteDir = join(root, sub);
    await mkdir(join(siteDir, 'assets'), { recursive: true });
    await writeFile(join(siteDir, 'index.html'), '<html><head><base href="/"></head></html>');
    await writeFile(join(siteDir, 'assets', 'main.js'), 'console.log("@{ not a template }")');
    return siteDir;
  }

  it('zips the built site from packDir and records the path', async () => {
    await buildSite();
    const artifact = { type: 'static-site', name: '@org/site' } as never;

    await getArtifactType('static-site').pack(artifact, ctx());

    const path = (artifact as { path?: string }).path;
    expect(path).toBe(join(outDir, 'org-site-site.zip'));
    expect(existsSync(path!)).toBe(true);
  });

  it('honours directory and packDir', async () => {
    await buildSite('app/dist/browser');
    const artifact = {
      type: 'static-site',
      name: 'docs',
      directory: 'app',
      packDir: 'dist/browser',
    } as never;

    await getArtifactType('static-site').pack(artifact, ctx());
    expect((artifact as { path?: string }).path).toBe(join(outDir, 'docs-site.zip'));
  });

  it('backfills the name from the project', async () => {
    await buildSite();
    const artifact = { type: 'static-site' } as never;
    await getArtifactType('static-site').pack(artifact, ctx());
    expect((artifact as { name: string }).name).toBe('@org/thing');
  });

  it('says what to fix when the build output is missing', async () => {
    const artifact = { type: 'static-site', name: 'site' } as never;
    await expect(getArtifactType('static-site').pack(artifact, ctx())).rejects.toThrow(
      /build output not found/,
    );
  });

  it('refuses a packDir that is not the served directory', async () => {
    await mkdir(join(root, 'dist', 'browser'), { recursive: true });
    await writeFile(join(root, 'dist', 'browser', 'index.html'), '<html></html>');
    const artifact = { type: 'static-site', name: 'site' } as never;
    await expect(getArtifactType('static-site').pack(artifact, ctx())).rejects.toThrow(
      /no index\.html/,
    );
  });

  it('rejects a registries declaration — there is nothing to publish', async () => {
    await buildSite();
    const artifact = { type: 'static-site', name: 'site', registries: ['npm'] } as never;
    await expect(getArtifactType('static-site').pack(artifact, ctx())).rejects.toThrow(
      /produces nothing to publish/,
    );
  });

  it('only a singleton can own the Pages root', async () => {
    await buildSite();
    const artifact = {
      type: 'static-site',
      name: 'site',
      pagesRoot: true,
      versioning: 'major',
    } as never;
    await expect(getArtifactType('static-site').pack(artifact, ctx())).rejects.toThrow(
      /pagesRoot with versioning: major/,
    );
  });

  it('never asks to publish', () => {
    const handler = getArtifactType('static-site');
    expect(handler.getRegistries({ registries: ['npm'] } as never)).toEqual([]);
    expect(handler.getVersion({} as never, '3.1.0')).toBe('3.1.0');
  });

  it('deploys through gh-pages, which runs two majors side by side', async () => {
    const { getDeployMethod } = await import('./deploy-methods.js');
    const handler = getDeployMethod('static-site', 'gh-pages');
    expect(handler).toBeDefined();
    expect(handler?.supportsParallelMajors).toBe(true);
    expect(handler?.templateIgnore).toEqual(['site/**']);
  });
});

describe('executable', () => {
  async function winBinary(productVersion: string | undefined, file = 'dist/tool.exe') {
    await mkdir(join(root, 'dist'), { recursive: true });
    const strings: Record<string, string> = productVersion
      ? { ProductVersion: productVersion }
      : {};
    await writeFile(
      join(root, file),
      buildPe({ versionInfo: buildVersionInfo({ fileVersion: [1, 2, 3, 0], strings }) }),
    );
  }
  async function script(output: string, file = 'dist/tool') {
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, file), `#!/bin/sh\necho "${output}"\n`);
    await chmod(join(root, file), 0o755);
  }
  const type = () => getArtifactType('executable');

  it('verifies a Windows binary by its PE version resource and attaches a checksum', async () => {
    await winBinary('1.2.3');
    const artifact = {
      type: 'executable',
      name: 'tool',
      path: 'dist/tool.exe',
      platform: 'win-x64',
    } as never as Record<string, unknown>;

    await type().pack(artifact as never, ctx('1.2.3'));

    expect(artifact.assetName).toBe('tool-win-x64.exe');
    expect(artifact.path).toBe(join(outDir, 'tool-win-x64.exe'));
    expect(existsSync(artifact.path as string)).toBe(true);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    const checksum = await readFile(join(outDir, 'tool-win-x64.exe.sha256'), 'utf-8');
    expect(checksum).toBe(`${artifact.sha256}  tool-win-x64.exe\n`);
  });

  it('creates the output directory when nothing has made it yet', async () => {
    // The executable can be a project's only artifact, so it is the first thing
    // written there on a fresh runner.
    await winBinary('1.2.3');
    await rm(outDir, { recursive: true, force: true });
    const artifact = { type: 'executable', name: 'tool', path: 'dist/tool.exe' } as never;
    await type().pack(artifact, ctx('1.2.3'));
    expect(existsSync(join(outDir, 'tool.exe'))).toBe(true);
    expect(existsSync(join(outDir, 'tool.exe.sha256'))).toBe(true);
  });

  it('refuses a stale build', async () => {
    await winBinary('1.2.2');
    const artifact = { type: 'executable', name: 'tool', path: 'dist/tool.exe' } as never;
    await expect(type().pack(artifact, ctx('1.2.3'))).rejects.toThrow(
      /reports version '1\.2\.2', but the release is '1\.2\.3'/,
    );
  });

  it('accepts a prerelease and ignores build metadata', async () => {
    await winBinary('v2.0.0-beta.1+abc1234');
    const artifact = { type: 'executable', name: 'tool', path: 'dist/tool.exe' } as never;
    await type().pack(artifact, ctx('2.0.0-beta.1'));
    expect((artifact as { assetName?: string }).assetName).toBe('tool.exe');
  });

  it('requires the ProductVersion string, not just the numeric version', async () => {
    await winBinary(undefined);
    const artifact = { type: 'executable', name: 'tool', path: 'dist/tool.exe' } as never;
    await expect(type().pack(artifact, ctx('1.2.3'))).rejects.toThrow(
      /no ProductVersion string.*numeric file version is 1\.2\.3\.0/s,
    );
  });

  it('says what to do when pe mode meets a non-PE file', async () => {
    await script('tool 1.2.3', 'dist/tool.exe');
    const artifact = { type: 'executable', name: 'tool', path: 'dist/tool.exe' } as never;
    await expect(type().pack(artifact, ctx('1.2.3'))).rejects.toThrow(/use 'version: exec'/);
  });

  it('exec mode runs the binary and matches the version in its output', async () => {
    await script('tool version 1.2.3-rc.2 (linux)');
    const artifact = {
      type: 'executable',
      name: 'tool',
      path: 'dist/tool',
      platform: 'linux-x64',
    } as never as Record<string, unknown>;
    await type().pack(artifact as never, ctx('1.2.3-rc.2'));
    expect(artifact.assetName).toBe('tool-linux-x64');
  });

  it('exec mode honours custom args and pattern, and rejects a mismatch', async () => {
    await script('build=9.9.9');
    const artifact = {
      type: 'executable',
      name: 'tool',
      path: 'dist/tool',
      versionArgs: ['version'],
      versionPattern: 'build=(\\S+)',
    } as never;
    await expect(type().pack(artifact, ctx('1.0.0'))).rejects.toThrow(/reports version '9\.9\.9'/);
  });

  it('exec mode explains when no version appears in the output', async () => {
    await script('hello');
    const artifact = { type: 'executable', name: 'tool', path: 'dist/tool' } as never;
    await expect(type().pack(artifact, ctx('1.0.0'))).rejects.toThrow(/no version in the output/);
  });

  it('none mode skips the check with a warning', async () => {
    await script('whatever');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const artifact = {
        type: 'executable',
        name: 'tool',
        path: 'dist/tool',
        version: 'none',
        checksum: false,
      } as never as Record<string, unknown>;
      await type().pack(artifact as never, ctx('1.0.0'));
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/version check disabled/));
      expect(artifact.checksumPath).toBeUndefined();
      expect(existsSync(join(outDir, 'tool.sha256'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('puts the version in the asset name only when asked', () => {
    const base = { name: '@org/tool', path: 'dist/tool.exe', platform: 'win-x64' };
    expect(executableAssetName(base, '1.2.3')).toBe('org-tool-win-x64.exe');
    expect(executableAssetName({ ...base, versionInName: true }, '1.2.3')).toBe(
      'org-tool-1.2.3-win-x64.exe',
    );
    expect(executableAssetName({ name: 'tool', path: 'bin/tool' }, '1.2.3')).toBe('tool');
  });

  it('normalises what toolchains add', () => {
    expect(normalizeBinaryVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeBinaryVersion('1.2.3-beta.1+sha.abc')).toBe('1.2.3-beta.1');
    expect(normalizeBinaryVersion(' 1.2.3 ')).toBe('1.2.3');
  });

  it('fails early when the build output is missing', async () => {
    const artifact = { type: 'executable', name: 'tool', path: 'dist/tool.exe' } as never;
    await expect(type().pack(artifact, ctx())).rejects.toThrow(/not found/);
  });

  it('rejects registries — the binary is attached to the release', async () => {
    await winBinary('1.2.3');
    const artifact = {
      type: 'executable',
      name: 'tool',
      path: 'dist/tool.exe',
      registries: ['x'],
    } as never;
    await expect(type().pack(artifact, ctx('1.2.3'))).rejects.toThrow(
      /produces nothing to publish/,
    );
  });

  it('never asks to publish', () => {
    expect(type().getRegistries({ registries: ['x'] } as never)).toEqual([]);
    expect(type().getVersion({} as never, '3.1.0')).toBe('3.1.0');
  });
});

describe('docker-image naming', () => {
  // `registries:` is a list — one image can publish to ghcr and ACR in the same
  // release. The artifact therefore carries only the bare repository name, and
  // each registry entry contributes its own host + namespace.
  it('defaults to the unscoped project name — no host, scope dropped', async () => {
    const artifact = { type: 'docker-image' } as never;

    // Pack fails later (no such docker image in this environment), but the name
    // is derived before that — which is what this asserts.
    await getArtifactType('docker-image')
      .pack(artifact, ctx())
      .catch(() => {});

    expect((artifact as { name: string }).name).toBe('thing');
  });

  it('rejects a name carrying a registry host', async () => {
    const artifact = {
      type: 'docker-image',
      name: 'ghcr.io/idealsupply/webservice-thing',
    } as never;

    await expect(getArtifactType('docker-image').pack(artifact, ctx())).rejects.toThrow(
      /bare image name.*Use name: webservice-thing/s,
    );
  });
});

describe('resolveDockerImageBase composition', () => {
  it('composes host/namespace/name per registry from a bare name', async () => {
    const { resolveDockerImageBase } = await import('../publishing/publishers.js');

    const ghcr = { type: 'docker', registry: 'ghcr.io', namespace: 'idealsupply' } as never;
    const acr = { type: 'docker', registry: 'ideal.azurecr.io', namespace: 'apps' } as never;

    // The same artifact lands at a different path per destination — the whole
    // point of keeping the name bare.
    expect(resolveDockerImageBase('webservice-deploy-gateway', ghcr)).toBe(
      'ghcr.io/idealsupply/webservice-deploy-gateway',
    );
    expect(resolveDockerImageBase('webservice-deploy-gateway', acr)).toBe(
      'ideal.azurecr.io/apps/webservice-deploy-gateway',
    );
  });

  it('a registry without a namespace prepends only its host', async () => {
    const { resolveDockerImageBase } = await import('../publishing/publishers.js');
    const bare = { type: 'docker', registry: 'registry.example.com' } as never;
    expect(resolveDockerImageBase('thing', bare)).toBe('registry.example.com/thing');
  });
});
