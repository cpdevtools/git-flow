/**
 * First-party artifact type plugins.
 *
 * These ship inside git-flow and register at module load, so they are available
 * without installing anything — like `npm` and `docker`. They are written
 * against the same plugin contract a third-party package would use, which keeps
 * that contract honest: if a plugin cannot express these, it cannot express much.
 *
 * Both publish through ordinary `nuget` / `npm` registries. Verification keys off
 * the *registry* type rather than the artifact type, so nothing extra is needed
 * to make post-publish checks work.
 */

import type { Artifact } from '@cpdevtools/ts-dev-utilities/artifacts';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { $ } from 'zx';
import { uploadArtifact } from '../build-pack/github.js';
import {
  floatingTagsFor,
  getToken,
  publishToNpm,
  publishToNuget,
  type NpmRegistry,
  type NugetRegistry,
} from '../publishing/index.js';
import { dockerCompose, dockerSwarm, dockerSwarmJob, ghPages } from './deploy-methods.js';
import { PeParseError, readPeVersion } from './pe-version.js';
import type { GitFlowPlugin } from './plugin.js';
import { safeName } from './slot.js';
import type { ArtifactType, PackContext } from './types.js';

/**
 * A .NET class library published to a NuGet registry.
 *
 * Distinct from the built-in `nuget` type, which does not pack anything — it
 * expects a `.nupkg` to already exist in the project directory (typically from
 * `GeneratePackageOnBuild`) and merely copies it, leaving the version to whatever
 * the build stamped. This type owns the pack and the version, so the package
 * version always matches the release.
 */
export interface DotnetLibArtifact {
  type: 'dotnet-lib';
  /** NuGet package id. */
  name: string;
  /** csproj path relative to the project dir. Defaults to the only one found. */
  project?: string;
  /** Build configuration. Defaults to Release. */
  configuration?: string;
  /** Populated by pack. */
  path?: string;
  registries?: string[];
  /**
   * Satisfies the Artifact union via CustomArtifact, which is how any type not
   * hardcoded into ts-dev-utilities stays assignable. Also what carries
   * `provider:` when two plugins supply this type.
   */
  [key: string]: unknown;
}

/**
 * An npm package built somewhere other than the project directory — typically a
 * generated API client, produced into a directory outside the workspace and
 * published from its own build output.
 *
 * The built-in `npm` type cannot express this: it runs `pnpm pack` in the
 * project directory and derives the tarball name from the project, so a client
 * that lives in `.clients/ng` and publishes from `dist/` is unreachable.
 */
export interface NgLibArtifact {
  type: 'ng-lib';
  /** npm package name, as published. */
  name: string;
  /** Where the package lives, relative to the project dir. */
  directory: string;
  /** Subdirectory the build emits, packed instead of the root. Defaults to 'dist'. */
  packDir?: string;
  /** Populated by pack. */
  path?: string;
  registries?: string[];
  /** See DotnetLibArtifact — satisfies the Artifact union via CustomArtifact. */
  [key: string]: unknown;
}

const dotnetLib: ArtifactType<DotnetLibArtifact> = {
  async pack(artifact, ctx) {
    const configuration = artifact.configuration ?? 'Release';
    const project = artifact.project ? join(ctx.projectCwd, artifact.project) : ctx.projectCwd;

    // Build first, then pack --no-build. A single `dotnet pack` relies on its
    // implicit build, and with GeneratePackageOnBuild / EF design-time
    // references in the csproj that evaluates the pack file list before
    // runtimeconfig.json exists on disk — NU5026. The version is stamped at
    // build so the assembly and the package agree, and a drifted package
    // version fails post-publish verification, which looks it up as
    // name@releaseVersion.
    await $({
      cwd: ctx.projectCwd,
    })`dotnet build ${project} -c ${configuration} -p:Version=${ctx.version} -p:PackageVersion=${ctx.version}`;
    await $({
      cwd: ctx.projectCwd,
    })`dotnet pack ${project} -c ${configuration} --no-build -o ${ctx.artifactOutputDir} -p:Version=${ctx.version} -p:PackageVersion=${ctx.version}`;

    // Read the produced filename rather than reconstructing it: the id can differ
    // from the assembly name, and NuGet normalises versions (1.2.3.0 -> 1.2.3).
    // .snupkg symbol packages also end with '.nupkg' — exclude them, they ride
    // along to the same registry via push, not as the primary artifact.
    const produced = (await readdir(ctx.artifactOutputDir)).filter(
      (f) => f.endsWith('.nupkg') && !f.endsWith('.snupkg'),
    );
    const match =
      produced.find(
        (f) => f.toLowerCase() === `${artifact.name}.${ctx.version}.nupkg`.toLowerCase(),
      ) ?? produced.find((f) => f.toLowerCase().startsWith(`${artifact.name.toLowerCase()}.`));

    if (!match) {
      throw new Error(
        `dotnet-lib: no .nupkg for '${artifact.name}' in ${ctx.artifactOutputDir}.\n` +
          `Produced: ${produced.join(', ') || '(none)'}\n` +
          `Check that the csproj PackageId matches the artifact name.`,
      );
    }

    artifact.path = join(ctx.artifactOutputDir, match);
    console.log(`  ✓ dotnet-lib: ${match}`);
  },
  async packDeploy() {
    // Not deployable on its own.
  },
  async upload(artifact, ctx) {
    if (!artifact.path) throw new Error(`dotnet-lib artifact ${artifact.name} missing path`);
    const path = isAbsolute(artifact.path) ? artifact.path : join(ctx.workspaceRoot, artifact.path);
    await uploadArtifact(ctx.githubToken, ctx.owner, ctx.repo, ctx.releaseId, ctx.uploadUrl, path);
  },
  async publish(artifact, registry, ctx) {
    if (!artifact.path) throw new Error(`dotnet-lib artifact ${artifact.name} missing path`);
    await publishToNuget({
      artifactPath: join(ctx.workspaceRoot, '.artifacts', basename(artifact.path)),
      registry: registry as NugetRegistry,
      apiKey: getToken(registry),
    });
  },
  getRegistries(artifact) {
    return artifact.registries ?? [];
  },
  getVersion(_, projectVersion) {
    return projectVersion;
  },
};

const ngLib: ArtifactType<NgLibArtifact> = {
  async pack(artifact, ctx) {
    if (!artifact.directory) {
      throw new Error(`ng-lib artifact '${artifact.name}' requires 'directory'`);
    }

    const sourceDir = join(ctx.projectCwd, artifact.directory);
    if (!existsSync(sourceDir)) {
      throw new Error(
        `ng-lib: '${artifact.directory}' does not exist (resolved to ${sourceDir}).\n` +
          `It is usually generated — make sure github.actions.build produced it before pack runs.`,
      );
    }

    const packDir = join(sourceDir, artifact.packDir ?? 'dist');

    // Building is the project's job, not this handler's: github.actions.build
    // runs before pack, and whatever it produced is what ships. Pack only
    // verifies — the checks below catch a build that never ran (missing dist)
    // or a stale one left over from a previous release (version drift; dist
    // directories are gitignored and survive on disk between releases).
    if (!existsSync(packDir)) {
      throw new Error(
        `ng-lib: build output '${artifact.packDir ?? 'dist'}' not found in ${sourceDir}.\n` +
          `The project's github.actions.build must build the client before pack runs.`,
      );
    }

    // Verification looks the package up as name@releaseVersion, so a generated
    // client still carrying its generator's version would publish fine and then
    // fail the release at the very end. Catch it here, where the message can say
    // what to fix.
    const manifest = JSON.parse(await readFile(join(packDir, 'package.json'), 'utf-8')) as {
      name?: string;
      version?: string;
    };

    if (manifest.version !== ctx.version) {
      throw new Error(
        `ng-lib: ${packDir}/package.json is version '${manifest.version}', but the release is ` +
          `'${ctx.version}'.\n` +
          `Publishing would succeed and then fail verification, which looks up ` +
          `${artifact.name}@${ctx.version}. The dist is stale or mis-stamped: the project's ` +
          `github.actions.build must regenerate and rebuild the client for every release, ` +
          `stamping its version from PROJECT_VERSION.`,
      );
    }

    const before = new Set(await readdir(ctx.artifactOutputDir).catch(() => []));
    await $({ cwd: packDir })`pnpm pack --pack-destination ${ctx.artifactOutputDir}`;
    const produced = (await readdir(ctx.artifactOutputDir)).filter(
      (f) => f.endsWith('.tgz') && !before.has(f),
    );

    if (produced.length !== 1) {
      throw new Error(
        `ng-lib: expected one new .tgz in ${ctx.artifactOutputDir}, got ${produced.length}` +
          (produced.length ? `: ${produced.join(', ')}` : ''),
      );
    }

    artifact.path = join(ctx.artifactOutputDir, produced[0]!);
    console.log(`  ✓ ng-lib: ${produced[0]}`);
  },
  async packDeploy() {
    // Not deployable on its own.
  },
  async upload(artifact, ctx) {
    if (!artifact.path) throw new Error(`ng-lib artifact ${artifact.name} missing path`);
    const path = isAbsolute(artifact.path) ? artifact.path : join(ctx.workspaceRoot, artifact.path);
    await uploadArtifact(ctx.githubToken, ctx.owner, ctx.repo, ctx.releaseId, ctx.uploadUrl, path);
  },
  async publish(artifact, registry, ctx) {
    if (!artifact.path) throw new Error(`ng-lib artifact ${artifact.name} missing path`);
    await publishToNpm({
      artifactPath: join(ctx.workspaceRoot, '.artifacts', basename(artifact.path)),
      registry: registry as NpmRegistry,
      token: getToken(registry),
      packageName: artifact.name,
      version: ctx.projectVersion,
      floatingTags: floatingTagsFor(artifact, ctx),
    });
  },
  getRegistries(artifact) {
    return artifact.registries ?? [];
  },
  getVersion(_, projectVersion) {
    return projectVersion;
  },
};

/**
 * A deployable set of services with no image of its own — third-party
 * infrastructure like traefik or mysql, where the repo's whole product is the
 * deploy bundle: stack/compose files referencing upstream images.
 *
 * `docker-image` minus the image: nothing is packed, uploaded or published to a
 * registry; the compose/swarm deploy methods are the same ones docker-image
 * uses, since they only ever operated on the deploy files.
 *
 * With nothing to build, such a project defines no `github.actions.build`.
 * Release participation hangs on `github.actions.pack` alone, and build-pack
 * packs/uploads build-less release projects after the build phase.
 */
export interface DockerServiceArtifact {
  type: 'docker-service';
  /**
   * Service name — drives the deployment slot and the shared-storage directory,
   * exactly as it does for docker-image. Backfilled with the project name at
   * pack time when the YAML omits it (required here only because the Artifact
   * union's CustomArtifact member demands it, as with NpmArtifact).
   */
  name: string;
  /** See DotnetLibArtifact — satisfies the Artifact union via CustomArtifact. */
  [key: string]: unknown;
}

const dockerService: ArtifactType<DockerServiceArtifact> = {
  async pack(artifact, ctx) {
    // The registries field is the one docker-image habit that cannot carry
    // over. Silently ignoring it would look like a publish that never happens.
    const declared = (artifact as { registries?: unknown }).registries;
    if (Array.isArray(declared) && declared.length > 0) {
      throw new Error(
        `docker-service '${artifact.name ?? ctx.projectName}' declares registries, but this ` +
          `type produces nothing to publish — its product is the deploy bundle.\n` +
          `Remove 'registries:', or use 'docker-image' if an image should be built and pushed.`,
      );
    }

    if (!artifact.name) (artifact as { name: string }).name = ctx.projectName;
    console.log(`  ✓ docker-service: ${artifact.name} (deploy bundle only)`);
  },
  async packDeploy() {
    // The orchestrator builds the bundle through the deploy-method handlers.
  },
  async upload() {
    // Nothing beyond the deploy-<method>.zip the orchestrator already uploads.
  },
  async publish() {
    // Unreachable: getRegistries is always empty.
  },
  getRegistries() {
    return [];
  },
  getVersion(_, projectVersion) {
    return projectVersion;
  },
};

/**
 * A built static site — an Angular/Vite/Astro app, generated docs, anything
 * whose product is a directory of files to serve as-is.
 *
 * Generic on purpose: the type only needs to know which directory the build
 * emitted into, never what produced it. Nothing publishes to a registry; the
 * product is the deploy bundle (`gh-pages`), with the site zipped onto the
 * release as a downloadable build.
 */
export interface StaticSiteArtifact {
  type: 'static-site';
  /** Site name — drives the deployment slot, and so the folder it lands in. */
  name: string;
  /** Where the site's project lives, relative to the project dir. Defaults to the project dir. */
  directory?: string;
  /** Subdirectory the build emits, relative to `directory`. Defaults to 'dist'. */
  packDir?: string;
  /**
   * This site owns the Pages root: its files land directly at `/` (or at the
   * environment prefix), not in a slot folder. Singleton only; one per repo.
   */
  pagesRoot?: boolean;
  /** Populated by pack. */
  path?: string;
  /** See DotnetLibArtifact — satisfies the Artifact union via CustomArtifact. */
  [key: string]: unknown;
}

const staticSite: ArtifactType<StaticSiteArtifact> = {
  async pack(artifact, ctx) {
    const declared = (artifact as { registries?: unknown }).registries;
    if (Array.isArray(declared) && declared.length > 0) {
      throw new Error(
        `static-site '${artifact.name ?? ctx.projectName}' declares registries, but this ` +
          `type produces nothing to publish — its product is the deploy bundle.`,
      );
    }
    if (!artifact.name) (artifact as { name: string }).name = ctx.projectName;

    if (artifact.pagesRoot === true && artifact.versioning === 'major') {
      throw new Error(
        `static-site '${artifact.name}' sets pagesRoot with versioning: major.\n` +
          `A root site has no version folder to live in — only a singleton can own the Pages root.`,
      );
    }

    const siteDir = join(ctx.projectCwd, artifact.directory ?? '.', artifact.packDir ?? 'dist');
    // Building is the project's job: github.actions.build runs before pack and
    // whatever it emitted is what ships. Pack only checks that it happened.
    if (!existsSync(siteDir)) {
      throw new Error(
        `static-site: build output not found at ${siteDir}.\n` +
          `The project's github.actions.build must produce the site before pack runs; ` +
          `point 'directory' / 'packDir' at where it emits.`,
      );
    }
    if (!existsSync(join(siteDir, 'index.html'))) {
      throw new Error(
        `static-site: ${siteDir} has no index.html.\n` +
          `'packDir' should name the directory that is served — for an Angular app that is ` +
          `usually dist/<project>/browser.`,
      );
    }

    const zipName = `${safeName(artifact.name)}-site.zip`;
    const zipPath = join(ctx.artifactOutputDir, zipName);
    await rm(zipPath, { force: true });
    await $({ cwd: siteDir })`zip -qr ${zipPath} .`;
    artifact.path = zipPath;
    console.log(`  ✓ static-site: ${zipName}`);
  },
  async packDeploy() {
    // The orchestrator builds the bundle through the gh-pages handler.
  },
  async upload(artifact, ctx) {
    if (!artifact.path) throw new Error(`static-site artifact ${artifact.name} missing path`);
    const path = isAbsolute(artifact.path) ? artifact.path : join(ctx.workspaceRoot, artifact.path);
    await uploadArtifact(ctx.githubToken, ctx.owner, ctx.repo, ctx.releaseId, ctx.uploadUrl, path);
  },
  async publish() {
    // Unreachable: getRegistries is always empty.
  },
  getRegistries() {
    return [];
  },
  getVersion(_, projectVersion) {
    return projectVersion;
  },
};

/**
 * A single built binary attached to the release — a PyInstaller one-file, a Go
 * or Rust binary, a .NET single-file publish, a Deno/Node SEA bundle. The type
 * never cares what produced it; it only sees the file.
 *
 * Like `ng-lib` it **verifies rather than builds**: `github.actions.build`
 * produces the binary, pack checks it is at the release version (a `dist`
 * directory survives between runs, and a build that silently failed leaves
 * yesterday's binary in place — publish would succeed and the release would
 * lie), copies it under its asset name, and writes a checksum beside it.
 */
export interface ExecutableArtifact {
  type: 'executable';
  /** Bare base name, e.g. `heroes-capture`. The asset name is composed from it. */
  name: string;
  /** The built file, relative to the project directory. */
  path: string;
  /** Target platform, e.g. `win-x64`; part of the asset name and label. */
  platform?: string;
  /** Attach `<asset>.sha256` (sha256sum format). Defaults to true. */
  checksum?: boolean;
  /** Asset content type. Defaults by extension (`.exe` → PE), else octet-stream. */
  contentType?: string;
  /**
   * How pack proves the binary is at the release version:
   *   pe   — read ProductVersion from the PE version resource, no execution
   *          (default for .exe / .dll)
   *   exec — run `<path> <versionArgs>` and match `versionPattern` on its output
   *          (default otherwise; needs a host that can run the binary)
   *   none — skip, with a warning (must be explicit)
   */
  version?: 'pe' | 'exec' | 'none';
  /** Arguments for `exec`. Defaults to `['--version']`. */
  versionArgs?: string[];
  /** Regex for `exec`; group 1 (or the whole match) is the version. */
  versionPattern?: string;
  /**
   * Put the version in the asset name (`name-1.2.3-win-x64.exe`). Off by
   * default so `releases/latest/download/<asset>` stays a stable URL.
   */
  versionInName?: boolean;
  /** Populated by pack: the asset name the file is published under. */
  assetName?: string;
  /** Populated by pack: sha256 of the binary. */
  sha256?: string;
  /** Populated by pack: the checksum file, when `checksum` is on. */
  checksumPath?: string;
  /** See DotnetLibArtifact — satisfies the Artifact union via CustomArtifact. */
  [key: string]: unknown;
}

const DEFAULT_VERSION_PATTERN = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

/** Strip what a toolchain adds and a release does not: a leading `v`, `+metadata`. */
export function normalizeBinaryVersion(v: string): string {
  return v.trim().replace(/^v/i, '').replace(/\+.*$/, '');
}

/** The asset name an executable artifact is published under. */
export function executableAssetName(
  artifact: Pick<ExecutableArtifact, 'name' | 'path' | 'platform' | 'versionInName'>,
  version: string,
): string {
  const parts = [safeName(artifact.name)];
  if (artifact.versionInName) parts.push(version);
  if (artifact.platform) parts.push(artifact.platform);
  return parts.join('-') + extname(artifact.path);
}

function defaultVersionMode(path: string): 'pe' | 'exec' {
  const ext = extname(path).toLowerCase();
  return ext === '.exe' || ext === '.dll' ? 'pe' : 'exec';
}

async function verifyExecutableVersion(
  artifact: ExecutableArtifact,
  filePath: string,
  ctx: PackContext,
): Promise<void> {
  const mode = artifact.version ?? defaultVersionMode(artifact.path);
  const label = `executable '${artifact.name}'`;
  const expected = normalizeBinaryVersion(ctx.version);

  if (mode === 'none') {
    console.warn(
      `  ⚠️  ${label}: version check disabled (version: none) — a stale build would ship unnoticed.`,
    );
    return;
  }

  let found: string;
  if (mode === 'pe') {
    let info;
    try {
      info = await readPeVersion(filePath);
    } catch (err) {
      if (err instanceof PeParseError) {
        throw new Error(
          `${label}: cannot read a version from ${artifact.path}: ${err.message}.\n` +
            `'version: pe' expects a Windows PE binary with a VS_VERSIONINFO resource. ` +
            `For a non-Windows binary use 'version: exec'.`,
        );
      }
      throw err;
    }
    if (!info.productVersion) {
      throw new Error(
        `${label}: ${artifact.path} has no ProductVersion string in its version resource` +
          (info.fixedFileVersion ? ` (numeric file version is ${info.fixedFileVersion})` : '') +
          `.\nThe fixed four-part version cannot carry a prerelease, so the string is required. ` +
          `Set it from PROJECT_VERSION in the build: PyInstaller --version-file, .NET ` +
          `<InformationalVersion>, Go goversioninfo, Rust winres/embed-resource.`,
      );
    }
    found = info.productVersion;
  } else if (mode === 'exec') {
    const args = artifact.versionArgs ?? ['--version'];
    const pattern = artifact.versionPattern
      ? new RegExp(artifact.versionPattern)
      : DEFAULT_VERSION_PATTERN;
    let output: string;
    try {
      const result = await $({ cwd: ctx.projectCwd, nothrow: true })`${filePath} ${args}`;
      output = `${result.stdout}\n${result.stderr}`;
      if (result.exitCode !== 0) {
        throw new Error(`exited ${result.exitCode}: ${output.trim()}`);
      }
    } catch (err) {
      throw new Error(
        `${label}: running '${artifact.path} ${args.join(' ')}' failed: ${(err as Error).message}\n` +
          `'version: exec' needs a host that can run the binary. For a Windows binary on a ` +
          `non-Windows runner use 'version: pe'.`,
      );
    }
    const match = pattern.exec(output);
    if (!match) {
      throw new Error(
        `${label}: no version in the output of '${artifact.path} ${args.join(' ')}' ` +
          `(pattern ${pattern}).\nOutput: ${output.trim().slice(0, 200)}`,
      );
    }
    found = match[1] ?? match[0];
  } else {
    throw new Error(`${label}: unknown version mode '${String(mode)}' (pe | exec | none)`);
  }

  if (normalizeBinaryVersion(found) !== expected) {
    throw new Error(
      `${label}: ${artifact.path} reports version '${found}', but the release is '${ctx.version}'.\n` +
        `The binary is stale or mis-stamped: the project's github.actions.build must rebuild it ` +
        `for every release, stamping its version from PROJECT_VERSION.`,
    );
  }
}

const executable: ArtifactType<ExecutableArtifact> = {
  async pack(artifact, ctx) {
    if (!artifact.name) (artifact as { name: string }).name = ctx.projectName;
    if (!artifact.path || typeof artifact.path !== 'string') {
      throw new Error(`executable '${artifact.name}' requires 'path'`);
    }
    const declared = (artifact as { registries?: unknown }).registries;
    if (Array.isArray(declared) && declared.length > 0) {
      throw new Error(
        `executable '${artifact.name}' declares registries, but this type produces nothing to ` +
          `publish — the binary is attached to the release.`,
      );
    }

    const source = isAbsolute(artifact.path) ? artifact.path : join(ctx.projectCwd, artifact.path);
    // Building is the project's job: github.actions.build runs before pack and
    // whatever it produced is what ships. Pack only checks that it happened.
    if (!existsSync(source)) {
      throw new Error(
        `executable: ${artifact.path} not found (resolved to ${source}).\n` +
          `The project's github.actions.build must produce it before pack runs.`,
      );
    }

    await verifyExecutableVersion(artifact, source, ctx);

    const assetName = executableAssetName(artifact, ctx.version);
    const dest = join(ctx.artifactOutputDir, assetName);
    // In Node rather than cp/sha256sum: this type has to work on a Windows
    // runner, where the usual shell tools are not a given.
    await copyFile(source, dest);
    const sha256 = createHash('sha256')
      .update(await readFile(dest))
      .digest('hex');

    artifact.assetName = assetName;
    artifact.path = dest;
    artifact.sha256 = sha256;
    if (artifact.checksum !== false) {
      const checksumPath = `${dest}.sha256`;
      // `sha256sum -c` format: two spaces between hash and name.
      await writeFile(checksumPath, `${sha256}  ${assetName}\n`);
      artifact.checksumPath = checksumPath;
    }
    console.log(`  ✓ executable: ${assetName} (sha256 ${sha256.slice(0, 12)}…)`);
  },
  async packDeploy() {
    // Not deployable on its own.
  },
  async upload(artifact, ctx) {
    if (!artifact.path || !artifact.assetName) {
      throw new Error(`executable artifact ${artifact.name} missing path — was pack run?`);
    }
    const path = isAbsolute(artifact.path) ? artifact.path : join(ctx.workspaceRoot, artifact.path);
    const label = [artifact.name, artifact.platform && `(${artifact.platform})`]
      .filter(Boolean)
      .join(' ');
    const contentType =
      artifact.contentType ??
      (extname(path).toLowerCase() === '.exe'
        ? 'application/vnd.microsoft.portable-executable'
        : 'application/octet-stream');
    await uploadArtifact(
      ctx.githubToken,
      ctx.owner,
      ctx.repo,
      ctx.releaseId,
      ctx.uploadUrl,
      path,
      artifact.assetName,
      { label, contentType },
    );
    if (artifact.checksumPath) {
      await uploadArtifact(
        ctx.githubToken,
        ctx.owner,
        ctx.repo,
        ctx.releaseId,
        ctx.uploadUrl,
        artifact.checksumPath,
        `${artifact.assetName}.sha256`,
        { label: `${label} sha256`, contentType: 'text/plain' },
      );
    }
  },
  async publish() {
    // Unreachable: getRegistries is always empty.
  },
  getRegistries() {
    return [];
  },
  getVersion(_, projectVersion) {
    return projectVersion;
  },
};

/** Shipped with git-flow; registered alongside the other built-ins. */
export const firstPartyPlugin: GitFlowPlugin = {
  name: '@cpdevtools/git-flow',
  artifactTypes: {
    'dotnet-lib': dotnetLib as unknown as ArtifactType<Artifact>,
    'ng-lib': ngLib as unknown as ArtifactType<Artifact>,
    'docker-service': dockerService as unknown as ArtifactType<Artifact>,
    'static-site': staticSite as unknown as ArtifactType<Artifact>,
    executable: executable as unknown as ArtifactType<Artifact>,
  },
  deployMethods: [
    // The same handlers docker-image uses: they copy stack/compose files and
    // write deploy.yml, and never needed an image to exist.
    { artifactType: 'docker-service', method: 'compose', handler: dockerCompose },
    { artifactType: 'docker-service', method: 'swarm', handler: dockerSwarm },
    { artifactType: 'docker-service', method: 'swarm-job', handler: dockerSwarmJob },
    // Runs inside the deploy workflow rather than on a host: pushes the site to
    // the gh-pages branch under its slot path.
    { artifactType: 'static-site', method: 'gh-pages', handler: ghPages },
  ],
};
