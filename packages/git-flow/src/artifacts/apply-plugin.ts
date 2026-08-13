/**
 * Applying a plugin manifest to the registries.
 *
 * The single path by which anything becomes available — the built-ins that ship
 * inside git-flow and the plugins a repo installs both arrive here. Keeping one
 * path is what makes the precedence rules mean the same thing for both, and what
 * keeps the published plugin contract exercised by first-party code.
 *
 * git-flow registers on the plugin's behalf rather than the plugin calling in.
 * See plugin.ts: a plugin resolved from a consuming repo would otherwise write
 * into a different copy of the registry than the process doing the dispatching.
 */

import { registerDeployMethod } from './deploy-methods.js';
import type { GitFlowPlugin, PluginApi } from './plugin.js';
import type { PluginAnchor } from './provider-registry.js';
import { registerArtifactType } from './registry.js';

export async function applyPlugin(
  plugin: GitFlowPlugin,
  provider: string,
  anchor: PluginAnchor,
): Promise<void> {
  for (const [type, handler] of Object.entries(plugin.artifactTypes ?? {})) {
    registerArtifactType(type, handler as never, provider, anchor);
  }

  for (const { artifactType, method, handler } of plugin.deployMethods ?? []) {
    registerDeployMethod(artifactType, method, handler, provider, anchor);
  }

  if (typeof plugin.register === 'function') {
    const api: PluginApi = {
      registerArtifactType: (type, handler) => registerArtifactType(type, handler, provider, anchor),
      registerDeployMethod: (artifactType, method, handler) =>
        registerDeployMethod(artifactType, method, handler, provider, anchor),
    };
    await plugin.register(api);
  }
}
