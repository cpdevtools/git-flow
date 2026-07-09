export interface DeployManifest {
  name: string;
  version: string;
  repo: string;
  releaseId: number;
  deployCommand: string;
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
}
