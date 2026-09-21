import type { ProjectConfig } from './npm.js';
import { rewriteNpmWorkspaceDependencies, restorePackageJson } from './npm.js';
import { rewriteNugetProjectReferences, restoreCsprojFiles } from './nuget.js';

export { type ProjectConfig };
export * from './npm.js';
export * from './nuget.js';

/**
 * Main function to rewrite workspace dependencies before packing.
 * Delegates to artifact-type-specific implementations.
 *
 * TODO (Phase 5): Add Docker workspace dependency rewriting.
 * Docker images need workspace references rewritten to point to published
 * registry images rather than local build artifacts.
 */
export async function rewriteWorkspaceDependencies(options: {
  project: ProjectConfig;
  allProjects: ProjectConfig[];
  artifactType?: 'npm' | 'nuget';
}): Promise<void> {
  const { project, allProjects, artifactType } = options;

  if (!artifactType || artifactType === 'npm') {
    await rewriteNpmWorkspaceDependencies({ project, allProjects });
  }

  if (!artifactType || artifactType === 'nuget') {
    await rewriteNugetProjectReferences({ project, allProjects });
  }
}

/**
 * Restore original project files after packing
 */
export async function restoreProjectFiles(projectCwd: string): Promise<void> {
  // Untracked / absent files are ignored inside; a real failure (e.g. a lost
  // index.lock) must surface, or a stamped file silently stays un-restored.

  // Restore NPM package.json
  await restorePackageJson(projectCwd);

  // Restore NuGet .csproj files
  await restoreCsprojFiles(projectCwd);
}
