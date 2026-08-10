/**
 * Shared-storage declaration. Legacy `string[]` (and `true`) create subdirs
 * directly under the service dir. The object form is only meaningful under the
 * stacked layout (see `stack`): `shared` entries survive major upgrades,
 * `versioned` entries are isolated per major.
 */
export type SharedStorageSpec = boolean | string[] | { shared?: string[]; versioned?: string[] };

export interface DeployManifest {
  name: string;
  version: string;
  repo: string;
  releaseId: number;
  deployCommand: string;
  /**
   * Shared stack this service is deployed into. Its presence switches shared
   * storage from the legacy flat `{base}/{service}/` layout to the versioned
   * `{base}/{stack}/{service}/{shared|v{major}}/` layout. Baked at pack time.
   */
  stack?: string;
  /**
   * Unscoped service segment for storage paths (e.g. '@org/app' → 'app'), or an
   * explicit override. Equals the SERVICE token baked into stack.yml. Baked at
   * pack time; runtime falls back to safeName(name) when absent.
   */
  service?: string;
  /**
   * Deploy method this bundle was packed for (e.g. 'node', 'compose', 'swarm').
   * Used to detect a mode change on redeploy. Optional for legacy bundles.
   */
  method?: string;
  /**
   * Deployment slot: the identity under which this instance runs and is
   * replaced. singleton → safeName(name); major → `${safeName(name)}-v${major}`.
   * Baked at pack time. Optional for legacy bundles (runtime falls back to
   * safeName(name)).
   */
  slot?: string;
  /** Versioning strategy used to derive `slot` ('singleton' | 'major'). */
  versioning?: 'singleton' | 'major';
  /**
   * Command that tears the running instance of this mode down (e.g.
   * `docker compose -p <slot> down`). Run from the saved bundle dir on a mode
   * change. Optional for legacy bundles (teardown skipped when absent).
   */
  teardownCommand?: string;
  /**
   * Legacy (no `stack`):
   *   true      → create $SHARED_STORAGE_BASE/{service}/
   *   string[]  → create $SHARED_STORAGE_BASE/{service}/ + each named subdir.
   * Stacked (`stack` set):
   *   true      → create the shared + v{major} buckets only
   *   string[]  → subdirs under the shared bucket (safe default: survives majors)
   *   { shared, versioned } → subdirs under the shared / v{major} buckets
   * Subdirs must be relative (no leading /) and must not contain '..' segments.
   */
  sharedStorage?: SharedStorageSpec;
  /**
   * Files copied from the bundle into shared storage, seed-if-missing: an
   * existing target is never overwritten, so operator edits survive redeploys.
   * `from` is relative to the extracted bundle dir. `to` is relative to the
   * service dir; under the stacked layout a `versioned/` prefix maps to
   * `v{major}/` and any other path lands under the service root (so
   * `shared/...` targets the shared bucket). Both must be relative and free of '..'.
   */
  seedStorage?: { from: string; to: string }[];
}

export interface DeployRequest {
  repo: string;
  release_id: number;
  bundle?: string;
  /** Extra environment variables merged into the deploy process for this run only. */
  env?: Record<string, string>;
}
