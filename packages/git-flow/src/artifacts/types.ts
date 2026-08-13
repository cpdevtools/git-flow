/**
 * Context and handler types for artifact types.
 *
 * Split out of index.ts so the plugin contract (plugin.ts) can reference
 * ArtifactType without importing index.ts, which imports the contract back.
 * index.ts re-exports everything here, so the public surface is unchanged.
 */

import type { Artifact } from '@cpdevtools/ts-dev-utilities/artifacts';
import type { Registry } from '../publishing/index.js';

export interface PackContext {
  /** Absolute path to the project directory */
  projectCwd: string;
  /**
   * Absolute path to the workspace root.
   *
   * Present so a handler can resolve anything outside its own project — a
   * generated client, a sibling tool — without guessing at `..` depth.
   */
  workspaceRoot: string;
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
  /** Absolute path to the workspace root */
  workspaceRoot: string;
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
