/**
 * The plugin contract.
 *
 * A plugin default-exports a manifest describing what it supplies. git-flow
 * imports the module, reads the export, and registers the handlers into its own
 * registry.
 *
 * ## Why declarative, and why plugins must not import git-flow at runtime
 *
 * The registries are module-private state inside a CJS bundle, so *every copy of
 * `@cpdevtools/git-flow` on disk owns a different one*. A plugin installed in a
 * consuming repo resolves that repo's copy — while the build-pack action runs
 * out of its own checkout under `${{ github.action_path }}`. A plugin that
 * called `registerArtifactType` itself would therefore register into a registry
 * the running process never reads, and would simply appear not to work.
 *
 * Exporting data instead of executing registration removes the problem: the
 * only thing crossing the boundary is a plain object, and the types come from
 * `import type`, which erases at compile time.
 *
 * ```ts
 * import type { GitFlowPlugin } from '@cpdevtools/git-flow/artifacts';
 *
 * export default {
 *   name: '@org/git-flow-plugin-helm',
 *   artifactTypes: { 'helm-chart': helmHandler },
 *   deployMethods: [{ artifactType: 'docker', method: 'k8s', handler: k8sHandler }],
 * } satisfies GitFlowPlugin;
 * ```
 *
 * ## Discovery
 *
 * Installing the package is all that is required. git-flow scans the project's
 * and the workspace root's dependencies for names matching `git-flow-plugin-*`
 * (optionally scoped) or manifests carrying a `gitflow.plugin` key. There is no
 * list to maintain in `release-artifacts.yml`.
 */

import type { Artifact } from '@cpdevtools/ts-dev-utilities/artifacts';
import type { DeployMethodHandler } from './deploy-methods.js';
import type { ArtifactType } from './types.js';

// Defined in provider-registry (which imports nothing) and re-exported here so
// the plugin contract stays the single place a plugin author has to read.
export { BUILTIN_PROVIDER } from './provider-registry.js';

export interface DeployMethodRegistration {
  /** Artifact type this method applies to — deploy methods are never global. */
  artifactType: string;
  /** Method name, e.g. 'swarm', 'compose', 'k8s'. */
  method: string;
  handler: DeployMethodHandler;
}

/**
 * Registration API handed to a plugin's optional `register()` hook.
 *
 * Passed by argument rather than imported, for the reason in the module header.
 */
export interface PluginApi {
  registerArtifactType(type: string, handler: ArtifactType<Artifact>): void;
  registerDeployMethod(artifactType: string, method: string, handler: DeployMethodHandler): void;
}

export interface GitFlowPlugin {
  /**
   * Package name. Used as the provider key, so it must match the installed
   * package name — it is what `provider:` in release-artifacts.yml refers to.
   */
  name: string;
  /** Artifact types this plugin supplies, keyed by type name. */
  artifactTypes?: Record<string, ArtifactType<never>>;
  /** Deploy methods this plugin supplies, each scoped to an artifact type. */
  deployMethods?: DeployMethodRegistration[];
  /**
   * Escape hatch for plugins that must compute their registrations. Runs after
   * the declarative fields are applied.
   */
  register?(api: PluginApi): void | Promise<void>;
}

/** Narrow an unknown module export to a plugin manifest. */
export function isGitFlowPlugin(value: unknown): value is GitFlowPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<GitFlowPlugin>;
  return typeof candidate.name === 'string';
}
