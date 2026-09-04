/**
 * Type definitions for Phase 3 Publishing
 */

/**
 * Registry configuration (loaded from .publish/registries.yml)
 */
export interface RegistryConfig {
  /** Registry configurations by name */
  registries: Record<string, Registry>;
}

/**
 * Base registry configuration
 */
export interface BaseRegistry {
  /** Environment variable name for authentication token */
  auth: string;
}

/**
 * NPM registry configuration
 */
export interface NpmRegistry extends BaseRegistry {
  type: 'npm';
  /** Registry URL */
  url: string;
  /** NPM scope (e.g., '@cpdevtools') */
  scope?: string;
}

/**
 * NuGet registry configuration
 */
export interface NugetRegistry extends BaseRegistry {
  type: 'nuget';
  /** Registry URL */
  url: string;
}

/**
 * Docker registry configuration
 */
export interface DockerRegistry extends BaseRegistry {
  type: 'docker';
  /** Registry host */
  registry: string;
  /** Docker namespace/organization */
  namespace?: string;
  /** Username environment variable (optional - defaults to using token only) */
  usernameEnv?: string;
}

/**
 * Union type for all registry types
 */
export type Registry = NpmRegistry | NugetRegistry | DockerRegistry;

/**
 * Options for publishing to NPM
 */
export interface NpmPublishOptions {
  artifactPath: string;
  registry: NpmRegistry;
  token: string;
  /** Package name, for `npm dist-tag add <name>@<version>` */
  packageName: string;
  /** Version being published */
  version: string;
  /** dist-tags this version earns, most important first (see floating-tags.ts) */
  floatingTags: string[];
}

/**
 * Options for publishing to NuGet
 */
export interface NugetPublishOptions {
  artifactPath: string;
  registry: NugetRegistry;
  apiKey: string;
}

/**
 * Options for publishing to Docker
 */
export interface DockerPublishOptions {
  imageName: string;
  /** Path to the gzipped image tarball (docker save output) to load and promote. */
  archivePath: string;
  finalTag: string;
  digest: string;
  registry: DockerRegistry;
  username?: string;
  token: string;
  /** Extra tags to push alongside `finalTag` (see floating-tags.ts) */
  floatingTags: string[];
}

/**
 * Result of a verification check
 */
export interface VerificationResult {
  published: boolean;
  version?: string;
  error?: string;
}

/**
 * Project information for publishing
 */
export interface PublishProjectInfo {
  name: string;
  version: string;
  releaseTag: string;
  prerelease: boolean;
  placeholder: string;
}

/**
 * Options for runPublishRelease
 */
export interface PublishReleaseOptions {
  workspaceRoot: string;
  prNumber: number;
  githubToken: string;
  owner: string;
  repo: string;
  sha: string;
  projects: PublishProjectInfo[];
}

/**
 * Result of publishing a single project
 */
export interface ProjectPublishResult {
  project: string;
  success: boolean;
  published: string[];
  verified: string[];
  error?: string;
}

/**
 * Result of runPublishRelease
 */
export interface PublishReleaseResult {
  published: string[];
  verified: string[];
  failed: ProjectPublishResult[];
  /** Markdown body listing published releases (also posted as the PR comment). */
  releaseComment?: string;
}
