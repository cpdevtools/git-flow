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
  type Registry,
} from '../publishing/index.js';

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
// Context types
// ---------------------------------------------------------------------------

export interface PackContext {
  /** Absolute path to the project directory */
  projectCwd: string;
  /** Absolute path to the shared artifact output directory */
  artifactOutputDir: string;
  /** Package name (e.g. '@org/my-app') */
  projectName: string;
  /** Release version string */
  version: string;
}

export interface PackDeployContext {
  /** Absolute path to the project directory */
  projectCwd: string;
  /** Absolute path to the shared artifact output directory */
  artifactOutputDir: string;
  /**
   * Absolute path to the directory the project's pack-deploy script wrote to.
   * Set from the DEPLOY_OUTPUT_DIR env var which the orchestrator provides.
   * Convention: <projectCwd>/.deploy-output/<safeName(artifact.name)>
   */
  deployOutputDir: string;
  /** Package name */
  projectName: string;
  /** Release version string */
  version: string;
  /** GitHub Release ID (numeric) */
  releaseId: number;
  /** owner/repo (from GITHUB_REPOSITORY) */
  githubRepository: string;
}

export interface UploadContext {
  githubToken: string;
  owner: string;
  repo: string;
  releaseId: number;
  uploadUrl: string;
  /** Workspace root for resolving relative artifact paths */
  workspaceRoot: string;
}

export interface PublishContext {
  /** Workspace root — artifact files are expected at <workspaceRoot>/.artifacts/<filename> */
  workspaceRoot: string;
  /** Project release version */
  projectVersion: string;
}

// ---------------------------------------------------------------------------
// ArtifactType interface
// ---------------------------------------------------------------------------

export interface ArtifactType<T extends Artifact = Artifact> {
  pack(artifact: T, ctx: PackContext): Promise<void>;
  packDeploy(artifact: T, ctx: PackDeployContext): Promise<void>;
  upload(artifact: T, ctx: UploadContext): Promise<void>;
  publish(artifact: T, registry: Registry, ctx: PublishContext): Promise<void>;
  /** Registry IDs to publish to.  Empty array = this type has no external publishing. */
  getRegistries(artifact: T): string[];
  /** Version string to use for verification/tagging.  Docker uses finalTag. */
  getVersion(artifact: T, projectVersion: string): string;
}

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
    const tarballName = `${safeName(artifact.name)}-${ctx.version}.tgz`;
    const src = join(ctx.projectCwd, tarballName);
    const dest = join(ctx.artifactOutputDir, tarballName);
    if (!existsSync(src)) {
      throw new Error(`npm tarball not found: ${src}`);
    }
    await mkdir(ctx.artifactOutputDir, { recursive: true });
    await copyFile(src, dest);
    artifact.path = dest;
    console.log(`  ✓ npm: ${tarballName}`);
  },
  async packDeploy() {
    // no-op
  },
  async upload(artifact, ctx) {
    const path = isAbsolute(artifact.path)
      ? artifact.path
      : join(ctx.workspaceRoot, artifact.path);
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
    const path = isAbsolute(artifact.path)
      ? artifact.path
      : join(ctx.workspaceRoot, artifact.path);
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

/** Docker — image is in the daemon; no file to copy or upload */
const docker: ArtifactType<DockerArtifact> = {
  async pack(artifact) {
    console.log(`  ✓ docker: ${artifact.name} (metadata only)`);
  },
  async packDeploy() {
    // no-op
  },
  async upload() {
    // Docker artifacts have no file upload; the image digest is in the release body
  },  async publish(artifact, registry) {
    if (!artifact.tempTag || !artifact.finalTag || !artifact.digest) {
      throw new Error(`docker artifact ${artifact.name} missing required fields (tempTag, finalTag, digest)`);
    }
    const dockerRegistry = registry as DockerRegistry;
    await publishToDocker({
      imageName: artifact.name,
      tempTag: artifact.tempTag,
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
  },};

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
    const path = isAbsolute(artifact.path)
      ? artifact.path
      : join(ctx.workspaceRoot, artifact.path);
    await uploadArtifact(ctx.githubToken, ctx.owner, ctx.repo, ctx.releaseId, ctx.uploadUrl, path);
  },
  async publish(artifact) {
    // Release attachments are already attached to the GitHub release; no external registry
    console.log(`  \u2139\ufe0f  ${artifact.name} is a release attachment \u2014 no external publishing needed`);
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

    // Zip the deploy output dir
    const zipName = `${safeName(artifact.name)}-deploy.zip`;
    await mkdir(ctx.artifactOutputDir, { recursive: true });
    const zipPath = join(ctx.artifactOutputDir, zipName);
    await $({ cwd: deployOutputDir })`zip -r ${zipPath} .`;

    artifact.path = zipPath;
    console.log(`  ✓ deploy: ${zipName}`);
  },
  async upload(artifact, ctx) {
    if (!artifact.path) {
      throw new Error(`Deploy artifact '${artifact.name}' has no path — was packDeploy run?`);
    }
    const path = isAbsolute(artifact.path)
      ? artifact.path
      : join(ctx.workspaceRoot, artifact.path);
    await uploadArtifact(ctx.githubToken, ctx.owner, ctx.repo, ctx.releaseId, ctx.uploadUrl, path);
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

const artifactTypeRegistry: Record<string, ArtifactType<any>> = {
  npm,
  nuget,
  docker,
  'release-attachment': releaseAttachment,
  deploy,
};

export function getArtifactType(type: string): ArtifactType {
  const handler = artifactTypeRegistry[type];
  if (!handler) {
    throw new Error(`Unknown artifact type: '${type}'`);
  }
  return handler;
}
