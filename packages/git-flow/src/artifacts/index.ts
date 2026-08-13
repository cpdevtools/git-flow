/**
 * Artifact type handler registry
 *
 * Each artifact type implements six lifecycle methods:
 *   pack          — run by `gitflow pack`; copies/validates output files
 *   packDeploy    — run by `gitflow pack-deploy`; finalises deploy bundles
 *   upload        — run by the build-pack orchestrator; uploads to the draft release
 *   publish       — run by the publish-release orchestrator; publishes to registries
 *   getRegistries — returns registry IDs to publish to (empty = skip publishing)
 *   getVersion    — returns the version string to use (docker uses finalTag)
 */

// Import deploy-methods first so built-in handlers are registered before any
// artifact-type code runs.  Side-effect import only.
import './deploy-methods.js';
export {
  registerDeployMethod,
  getDeployMethod,
  listDeployMethods,
  listDeployMethodProviders,
  type DeployMethodHandler,
  type DeployMethodContext,
} from './deploy-methods.js';

// The plugin contract and the registry that backs precedence.
export {
  BUILTIN_PROVIDER,
  isGitFlowPlugin,
  type GitFlowPlugin,
  type PluginApi,
  type DeployMethodRegistration,
} from './plugin.js';
export { ProviderConflictError, type PluginAnchor } from './provider-registry.js';
export type { DotnetLibArtifact, NgLibArtifact } from './builtin-plugins.js';
export {
  loadPlugins,
  findWorkspaceRoot,
  type LoadedPlugin,
  type LoadPluginsOptions,
} from './load-plugins.js';

// Context and handler types moved to types.ts so the plugin contract can
// reference them without importing this module back.
export type {
  PackContext,
  PackDeployContext,
  UploadContext,
  PublishContext,
  ArtifactType,
} from './types.js';

import type {
  Artifact,
  DeployArtifact,
  DockerArtifact,
  NpmArtifact,
  NuGetArtifact,
  ReleaseAttachment,
} from '@cpdevtools/ts-dev-utilities/artifacts';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { $ } from 'zx';
import { uploadArtifact } from '../build-pack/github.js';
import {
  publishToNpm,
  publishToNuget,
  publishToDocker,
  getToken,
  type NpmRegistry,
  type NugetRegistry,
  type DockerRegistry,
} from '../publishing/index.js';
import { BUILTIN_PROVIDER } from './provider-registry.js';
import { applyPlugin } from './apply-plugin.js';
import { builtinDeployMethods } from './deploy-methods.js';
import type { GitFlowPlugin } from './plugin.js';
import { firstPartyPlugin } from './builtin-plugins.js';
import type { ArtifactType } from './types.js';

// Re-export artifact types so consumers of @cpdevtools/git-flow/artifacts
// don't need a direct dependency on @cpdevtools/ts-dev-utilities
export type {
  Artifact,
  DeployArtifact,
  DockerArtifact,
  NpmArtifact,
  NuGetArtifact,
  ReleaseAttachment,
} from '@cpdevtools/ts-dev-utilities/artifacts';
export type { ProjectArtifactDescriptor } from '@cpdevtools/ts-dev-utilities/artifacts';
export { writeArtifact } from '@cpdevtools/ts-dev-utilities/artifacts';

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Convert a package name to a safe filename component (strips @ and replaces / with -) */
export function safeName(name: string): string {
  return name.replace(/@/g, '').replace(/\//g, '-');
}

// ---------------------------------------------------------------------------
// Type implementations
// ---------------------------------------------------------------------------

const npm: ArtifactType<NpmArtifact> = {
  async pack(artifact, ctx) {
    await mkdir(ctx.artifactOutputDir, { recursive: true });
    await $({ cwd: ctx.projectCwd })`pnpm pack --pack-destination ${ctx.artifactOutputDir}`;
    // Derive name from project name if absent in release-artifacts.yml
    const resolvedName = artifact.name || ctx.projectName;
    if (!artifact.name) (artifact as { name: string }).name = resolvedName;
    const tarballName = `${safeName(resolvedName)}-${ctx.version}.tgz`;
    artifact.path = join(ctx.artifactOutputDir, tarballName);
    console.log(`  ✓ npm: ${tarballName}`);
  },
  async packDeploy() {
    // no-op
  },
  async upload(artifact, ctx) {
    if (!artifact.path) throw new Error(`npm artifact ${artifact.name} missing path`);
    const path = isAbsolute(artifact.path) ? artifact.path : join(ctx.workspaceRoot, artifact.path);
    await uploadArtifact(ctx.githubToken, ctx.owner, ctx.repo, ctx.releaseId, ctx.uploadUrl, path);
  },
  async publish(artifact, registry, ctx) {
    if (!artifact.path) throw new Error(`npm artifact ${artifact.name} missing path`);
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

const nuget: ArtifactType<NuGetArtifact> = {
  async pack(artifact, ctx) {
    const nupkgName = `${safeName(artifact.name)}.${ctx.version}.nupkg`;
    const src = join(ctx.projectCwd, nupkgName);
    const dest = join(ctx.artifactOutputDir, nupkgName);
    if (!existsSync(src)) {
      throw new Error(`NuGet package not found: ${src}`);
    }
    await mkdir(ctx.artifactOutputDir, { recursive: true });
    await copyFile(src, dest);
    artifact.path = dest;
    console.log(`  ✓ nuget: ${nupkgName}`);
  },
  async packDeploy() {
    // no-op
  },
  async upload(artifact, ctx) {
    const path = isAbsolute(artifact.path) ? artifact.path : join(ctx.workspaceRoot, artifact.path);
    await uploadArtifact(ctx.githubToken, ctx.owner, ctx.repo, ctx.releaseId, ctx.uploadUrl, path);
  },
  async publish(artifact, registry, ctx) {
    if (!artifact.path) throw new Error(`nuget artifact ${artifact.name} missing path`);
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

/** Docker — save the built image to a tarball artifact; publish loads & pushes it */
const docker: ArtifactType<DockerArtifact> = {
  async pack(artifact, ctx) {
    // Derive image name if absent: ghcr.io/{owner}/{unscoped-project-name}
    //
    // The npm scope must be DROPPED, not flattened. The registry path already
    // carries the org, so `safeName('@cpdevtools/git-flow-deploy-service')`
    // would produce ghcr.io/cpdevtools/cpdevtools-git-flow-deploy-service —
    // the org repeated. Strip the scope so it stays
    // ghcr.io/cpdevtools/git-flow-deploy-service.
    if (!artifact.name) {
      const owner = process.env.GITHUB_REPOSITORY_OWNER ?? '';
      const bareName = safeName(ctx.projectName.replace(/^@[^/]+\//, ''));
      (artifact as { name: string }).name = `ghcr.io/${owner}/${bareName}`;
    }
    // localTag is the image as it was built locally (no registry prefix). This
    // one KEEPS the flattened scope (`cpdevtools-git-flow-deploy-service`)
    // because local tags share a flat namespace across the workspace and must
    // match what the project's own `build:docker` script tagged.
    const source =
      (artifact as { localTag?: string }).localTag ?? `${safeName(ctx.projectName)}:latest`;
    const registryHost = artifact.name.includes('/') ? artifact.name.split('/')[0] : 'docker.io';
    const archiveName = `${safeName(artifact.name)}.image.tar.gz`;
    const archivePath = join(ctx.artifactOutputDir, archiveName);

    await mkdir(ctx.artifactOutputDir, { recursive: true });

    // Capture the image config id (.Id) — stable across docker save/load — to
    // verify the image content in the publish phase.
    const digest = (await $`docker inspect --format='{{.Id}}' ${source}`).stdout
      .trim()
      .replace(/^'|'$/g, '');

    // Serialize the image to a gzipped tarball artifact. No registry temp tag is
    // pushed, so the registry only ever sees the final release/latest tags.
    await $`docker save ${source} | gzip > ${archivePath}`;

    artifact.finalTag = ctx.version;
    artifact.digest = digest;
    artifact.registry = registryHost;
    artifact.pushedAt = new Date().toISOString();
    (artifact as { imageArchive?: string }).imageArchive = archivePath;

    console.log(`  ✓ docker: saved ${source} → ${archiveName}`);
    console.log(`  ✓ digest: ${digest}`);
  },
  async packDeploy() {
    // no-op
  },
  async upload(artifact, ctx) {
    const imageArchive = (artifact as { imageArchive?: string }).imageArchive;
    if (!imageArchive) {
      throw new Error(`docker artifact ${artifact.name} missing image archive (run pack first)`);
    }
    const path = isAbsolute(imageArchive) ? imageArchive : join(ctx.workspaceRoot, imageArchive);
    await uploadArtifact(ctx.githubToken, ctx.owner, ctx.repo, ctx.releaseId, ctx.uploadUrl, path);
  },
  async publish(artifact, registry, ctx) {
    const imageArchive = (artifact as { imageArchive?: string }).imageArchive;
    if (!imageArchive || !artifact.finalTag || !artifact.digest) {
      throw new Error(
        `docker artifact ${artifact.name} missing required fields (imageArchive, finalTag, digest)`,
      );
    }
    const dockerRegistry = registry as DockerRegistry;
    await publishToDocker({
      imageName: artifact.name,
      archivePath: join(ctx.workspaceRoot, '.artifacts', basename(imageArchive)),
      finalTag: artifact.finalTag,
      digest: artifact.digest,
      registry: dockerRegistry,
      username: dockerRegistry.usernameEnv ? process.env[dockerRegistry.usernameEnv] : undefined,
      token: getToken(registry),
    });
  },
  getRegistries(artifact) {
    return artifact.registries ?? [];
  },
  getVersion(artifact, projectVersion) {
    return artifact.finalTag || projectVersion;
  },
};

const releaseAttachment: ArtifactType<ReleaseAttachment> = {
  async pack(artifact) {
    if (!existsSync(artifact.path)) {
      throw new Error(`Release attachment not found: ${artifact.path}`);
    }
    console.log(`  ✓ release-attachment: ${artifact.path}`);
  },
  async packDeploy() {
    // no-op
  },
  async upload(artifact, ctx) {
    const path = isAbsolute(artifact.path) ? artifact.path : join(ctx.workspaceRoot, artifact.path);
    await uploadArtifact(ctx.githubToken, ctx.owner, ctx.repo, ctx.releaseId, ctx.uploadUrl, path);
  },
  async publish(artifact) {
    // Release attachments are already attached to the GitHub release; no external registry
    console.log(
      `  \u2139\ufe0f  ${artifact.name} is a release attachment \u2014 no external publishing needed`,
    );
  },
  getRegistries() {
    return [];
  },
  getVersion(_, projectVersion) {
    return projectVersion;
  },
};

const deploy: ArtifactType<DeployArtifact> = {
  async pack() {
    // Deploy zip is produced by packDeploy; nothing to do at pack time
  },
  async packDeploy(artifact, ctx) {
    const { deployOutputDir } = ctx;
    const deployYmlPath = join(deployOutputDir, 'deploy.yml');

    if (!existsSync(deployOutputDir)) {
      throw new Error(
        `Deploy output dir not found: ${deployOutputDir}\n` +
          `The project's github.actions.pack-deploy script must write files to DEPLOY_OUTPUT_DIR.`,
      );
    }
    if (!existsSync(deployYmlPath)) {
      throw new Error(
        `deploy.yml not found in ${deployOutputDir}.\n` +
          `The project's github.actions.pack-deploy script must write deploy.yml.`,
      );
    }

    const existing = parse(await readFile(deployYmlPath, 'utf-8')) as Record<string, unknown>;
    if (!existing.deployCommand) {
      throw new Error(`deploy.yml is missing required field: deployCommand`);
    }

    // Inject git-flow-managed metadata (overwrites any project-supplied values)
    await writeFile(
      deployYmlPath,
      stringify({
        ...existing,
        name: artifact.name,
        version: ctx.version,
        repo: `https://github.com/${ctx.githubRepository}`,
        releaseId: ctx.releaseId,
      }),
    );

    // Zip the deploy output dir. The on-disk name stays unique per-artifact so
    // parallel projects don't collide in the shared staging dir; the release
    // asset is always published as `deploy.zip` (one deploy bundle per release).
    const zipName = `${safeName(artifact.name)}-deploy.zip`;
    await mkdir(ctx.artifactOutputDir, { recursive: true });
    const zipPath = join(ctx.artifactOutputDir, zipName);
    await $({ cwd: deployOutputDir })`zip -r ${zipPath} .`;

    artifact.path = zipPath;
    console.log(`  ✓ deploy: deploy.zip`);
  },
  async upload(artifact, ctx) {
    if (!artifact.path) {
      throw new Error(`Deploy artifact '${artifact.name}' has no path — was packDeploy run?`);
    }
    const path = isAbsolute(artifact.path) ? artifact.path : join(ctx.workspaceRoot, artifact.path);
    await uploadArtifact(
      ctx.githubToken,
      ctx.owner,
      ctx.repo,
      ctx.releaseId,
      ctx.uploadUrl,
      path,
      'deploy.zip',
    );
  },
  async publish() {
    // Deploy zips are consumed from the GitHub release by the deploy service;
    // no external registry publishing needed
  },
  getRegistries() {
    return [];
  },
  getVersion(_, projectVersion) {
    return projectVersion;
  },
};

// ---------------------------------------------------------------------------
// Registry & lookup
// ---------------------------------------------------------------------------

/**
 * Everything git-flow ships with, expressed as a plugin.
 *
 * Not a privileged set seeded behind the registry's back: the built-ins declare
 * themselves the same way an installed package does, reach the registry through
 * the same applyPlugin, and sit at the lowest rung of the same ladder — so
 * anything a repo installs outranks them. It also means the published plugin
 * contract is exercised by first-party code, and cannot quietly rot.
 */
export const builtinPlugin: GitFlowPlugin = {
  name: BUILTIN_PROVIDER,
  artifactTypes: {
    npm: npm as unknown as ArtifactType<Artifact>,
    nuget: nuget as unknown as ArtifactType<Artifact>,
    docker: docker as unknown as ArtifactType<Artifact>,
    'release-attachment': releaseAttachment as unknown as ArtifactType<Artifact>,
    deploy: deploy as unknown as ArtifactType<Artifact>,
    ...(firstPartyPlugin.artifactTypes ?? {}),
  },
  deployMethods: builtinDeployMethods,
};

// Registered at module load, before anything can dispatch an artifact.
void applyPlugin(builtinPlugin, BUILTIN_PROVIDER, 'builtin');

// Registry accessors live in registry.ts so applyPlugin can use them without
// importing this module back.
export {
  registerArtifactType,
  getArtifactType,
  listArtifactTypes,
  listArtifactTypeProviders,
  providerOf,
} from './registry.js';

