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
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { $ } from 'zx';
import { uploadArtifact } from '../build-pack/github.js';
import {
  getToken,
  publishToNpm,
  publishToNuget,
  type NpmRegistry,
  type NugetRegistry,
} from '../publishing/index.js';
import type { GitFlowPlugin } from './plugin.js';
import type { ArtifactType } from './types.js';

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
  /** Build command run inside `directory`. Skipped when packDir already exists. */
  build?: string;
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

    // -p:Version rather than a prior `dotnet build`: the release version is only
    // known here, and a package whose version drifts from the release fails
    // post-publish verification, which looks it up as name@releaseVersion.
    await $({
      cwd: ctx.projectCwd,
    })`dotnet pack ${project} -c ${configuration} -o ${ctx.artifactOutputDir} -p:Version=${ctx.version} -p:PackageVersion=${ctx.version}`;

    // Read the produced filename rather than reconstructing it: the id can differ
    // from the assembly name, and NuGet normalises versions (1.2.3.0 -> 1.2.3).
    const produced = (await readdir(ctx.artifactOutputDir)).filter((f) => f.endsWith('.nupkg'));
    const match =
      produced.find((f) => f.toLowerCase() === `${artifact.name}.${ctx.version}.nupkg`.toLowerCase()) ??
      produced.find((f) => f.toLowerCase().startsWith(`${artifact.name.toLowerCase()}.`));

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

    if (artifact.build && !existsSync(packDir)) {
      await $({ cwd: sourceDir, shell: true })`${artifact.build}`;
    }

    if (!existsSync(packDir)) {
      throw new Error(
        `ng-lib: build output '${artifact.packDir ?? 'dist'}' not found in ${sourceDir}.\n` +
          `Either build it in github.actions.build, or set 'build:' on the artifact.`,
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
          `${artifact.name}@${ctx.version}. Stamp the generated package from PROJECT_VERSION.`,
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
    });
  },
  getRegistries(artifact) {
    return artifact.registries ?? [];
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
  },
};
