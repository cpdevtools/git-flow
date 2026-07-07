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
export { applyVersion, executePack, executeUpload } from './execute.js';

// Project discovery (shared utility)
export {
  discoverProjects,
  buildDependencyGraph,
  type Project,
  type DependencyGraph,
} from '../lib/project.js';

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
  deleteDraftRelease,
  detectDraftReleases,
  postPRReleaseComment,
} from './github.js';

// Options parsing
export { extractPRMetadata } from './options.js';

// Artifact generation
export {
  generateArtifactDescriptor,
  loadArtifactConfig,
  ARTIFACT_OUTPUT_DIR,
  type ArtifactConfig,
  type PluginConfig,
} from './generate-artifact.js';

// Workspace dependency rewriting (for Phase 2)
export {
  rewriteWorkspaceDependencies,
  restoreProjectFiles,
  rewriteNpmWorkspaceDependencies,
  restorePackageJson,
  rewriteNugetProjectReferences,
  restoreCsprojFiles,
} from './workspace-deps/index.js';
