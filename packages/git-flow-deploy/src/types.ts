export interface DeployManifest {
  name: string;
  version: string;
  repo: string;
  releaseId: number;
  deployCommand: string;
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
   * true  → create $SHARED_STORAGE_BASE/{name}/
   * string[] → create $SHARED_STORAGE_BASE/{name}/ and each named subdir within it.
   * Subdirs must be relative (no leading /) and must not contain '..' segments.
   */
  sharedStorage?: boolean | string[];
}

export interface DeployRequest {
  repo: string;
  release_id: number;
  bundle?: string;
}
