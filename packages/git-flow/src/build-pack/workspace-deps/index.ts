import type { ProjectConfig } from './npm.js';
import { rewriteNpmWorkspaceDependencies, restorePackageJson } from './npm.js';
import { rewriteNugetProjectReferences, restoreCsprojFiles } from './nuget.js';
import { verifyDockerImageTags } from './docker.js';

export { type ProjectConfig };
export * from './npm.js';
export * from './nuget.js';
export * from './docker.js';

/**
 * Main function to rewrite workspace dependencies before packing
 * Delegates to artifact-type-specific implementations
 */
export async function rewriteWorkspaceDependencies(options: {
  project: ProjectConfig;
  allProjects: ProjectConfig[];
  artifactType?: 'npm' | 'nuget' | 'docker';
}): Promise<void> {
  const { project, allProjects, artifactType } = options;

  // If artifact type is not specified, try all
  if (!artifactType || artifactType === 'npm') {
    // Use direct static import
    await rewriteNpmWorkspaceDependencies({ project, allProjects });
  }

  if (!artifactType || artifactType === 'nuget') {
    // Use direct static import
    await rewriteNugetProjectReferences({ project, allProjects });
  }

  if (!artifactType || artifactType === 'docker') {
    // Use direct static import
    await verifyDockerImageTags({ project, allProjects });
  }
}

/**
 * Restore original project files after packing
 */
export async function restoreProjectFiles(projectCwd: string): Promise<void> {
  // Restore NPM package.json
  await restorePackageJson(projectCwd).catch(() => {});

  // Restore NuGet .csproj files
  await restoreCsprojFiles(projectCwd).catch(() => {});
}
