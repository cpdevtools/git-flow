/**
 * The artifact-type registry.
 *
 * Split out of index.ts so that registration can be shared: index.ts defines the
 * built-in handlers and registers them *as a plugin*, and load-plugins.ts does
 * the same for installed ones. Both go through apply-plugin.ts, which needs the
 * registry without index.ts needing apply-plugin — hence this module.
 */

import type { Artifact } from '@cpdevtools/ts-dev-utilities/artifacts';
import { BUILTIN_PROVIDER, ProviderRegistry, type PluginAnchor } from './provider-registry.js';
import type { ArtifactType } from './types.js';

const artifactTypeRegistry = new ProviderRegistry<ArtifactType<any>>('artifact type');

/**
 * Register an artifact type handler.
 *
 * Prefer declaring types on a plugin manifest — this is the low-level primitive
 * that applyPlugin calls, and the built-ins reach it the same way.
 */
export function registerArtifactType(
  type: string,
  handler: ArtifactType<any>,
  provider: string = BUILTIN_PROVIDER,
  anchor: PluginAnchor = 'builtin',
): void {
  artifactTypeRegistry.register(type, handler, provider, anchor);
}

/** Every registered artifact type name, sorted. */
export function listArtifactTypes(): string[] {
  return artifactTypeRegistry.keys();
}

/** Packages supplying a given artifact type — for disambiguation messages. */
export function listArtifactTypeProviders(type: string): string[] {
  return artifactTypeRegistry.providersOf(type);
}

/**
 * The provider an artifact pins itself to, if any.
 *
 * `provider:` is only needed when two installed plugins supply the same type —
 * it is how one artifact can use one of them while another uses the other.
 */
export function providerOf(artifact: Artifact): string | undefined {
  const pinned = (artifact as { provider?: unknown }).provider;
  return typeof pinned === 'string' ? pinned : undefined;
}

/**
 * Resolve the handler for an artifact type.
 *
 * `provider` pins the choice when more than one plugin supplies the type; without
 * it, the most local registration wins and a same-level tie throws.
 */
export function getArtifactType(type: string, provider?: string): ArtifactType {
  const handler = artifactTypeRegistry.resolve(type, provider);
  if (!handler) {
    throw new Error(
      `Unknown artifact type: '${type}'. Registered types: ${listArtifactTypes().join(', ')}`,
    );
  }
  return handler;
}
