/**
 * Phase 2: Build & Pack
 * 
 * Orchestrates building and packaging projects from a GitHub PR description.
 * Creates draft releases with artifacts for projects marked for release.
 * 
 * @module build-pack
 */

// Main orchestration entry point
export { runBuildPack } from './orchestrate.js';

// Types
export type {
  BuildPackContext,
  ProjectConfig,
  ExecutionResult,
  PRMetadata,
  PRProjectMetadata,
  BuildPackResult,
} from './types.js';

// Execution functions (for advanced usage/testing)
export { executeBuild, executePack, executeUpload } from './execute.js';

// GitHub API operations (for advanced usage/testing)
export {
  getReleaseTag,
  findDraftReleaseByTag,
  createDraftRelease,
  updateDraftReleaseBody,
  findOrCreateDraftRelease,
  isArtifactUploaded,
  uploadArtifact,
  getDraftReleaseMetadata,
} from './github.js';

// Options parsing
export { extractPRMetadata } from './options.js';

// Workspace dependency rewriting (for Phase 2)
export {
  rewriteWorkspaceDependencies,
  restoreProjectFiles,
  rewriteNpmWorkspaceDependencies,
  restorePackageJson,
  rewriteNugetProjectReferences,
  restoreCsprojFiles,
  verifyDockerImageTags,
} from './workspace-deps/index.js';
