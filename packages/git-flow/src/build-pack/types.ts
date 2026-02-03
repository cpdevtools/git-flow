/**
 * Type definitions for Phase 2 Build & Pack workflow
 */

import type { Project } from '../lib/project';

/**
 * Project configuration for build & pack workflow
 */
export interface ProjectConfig extends Project {
  /** Project name - inherited from Project but explicitly declared for type safety */
  name: string;
  /** Working directory (absolute path) - same as directory from Project */
  cwd: string;
  /** Project version to build */
  version: string;
  /** Whether this is a prerelease version */
  prerelease: boolean;
}

/**
 * Execution result for a project
 */
export interface ExecutionResult {
  /** Project name */
  project: string;
  /** Whether execution succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Exit code if available */
  exitCode?: number;
}

/**
 * Build & Pack workflow context
 */
export interface BuildPackContext {
  /** Workspace root directory */
  workspaceRoot: string;
  /** Artifact output directory (for artifact.yml files) */
  artifactOutputDir: string;
  /** GitHub token for API access */
  githubToken: string;
  /** Pull request number */
  prNumber: number;
  /** Git commit SHA */
  sha: string;
  /** Workflow run number */
  runNumber: number;
  /** Skip upload phase (useful for local testing) */
  skipUpload?: boolean;
  /** All projects in the workspace (for workspace dependency resolution) */
  allProjects?: ProjectConfig[];
}

/**
 * PR metadata from PR body YAML block
 */
export interface PRMetadata {
  /** Projects grouped by version placeholder (e.g., 'DEFAULT', 'V1_8_LTS') */
  projectsByPlaceholder: Record<string, PRProjectMetadata[]>;
  /** Force rebuild - delete existing draft releases and rebuild all artifacts */
  forceRebuild?: boolean;
}

/**
 * Project metadata from PR body
 */
export interface PRProjectMetadata {
  /** Project name */
  name: string;
  /** Version placeholder from package.json (e.g., '0.0.0-DEFAULT') */
  placeholder: string;
  /** Resolved version to build */
  version: string;
  /** Whether this is a prerelease */
  prerelease: boolean;
  /** Project working directory relative to workspace root */
  cwd: string;
}

/**
 * Result of build & pack workflow
 */
export interface BuildPackResult {
  /** Projects that were built */
  built: string[];
  /** Projects that were packed */
  packed: string[];
  /** Projects that were uploaded */
  uploaded: string[];
  /** Projects that were skipped (already complete) */
  skipped: string[];
  /** Projects that failed */
  failed: ExecutionResult[];
}
