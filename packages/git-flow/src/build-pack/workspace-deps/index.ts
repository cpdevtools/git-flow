import type { ProjectConfig } from './npm.js';

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
    const { rewriteNpmWorkspaceDependencies } = await import('./npm.js');
    await rewriteNpmWorkspaceDependencies({ project, allProjects });
  }

  if (!artifactType || artifactType === 'nuget') {
    const { rewriteNugetProjectReferences } = await import('./nuget.js');
    await rewriteNugetProjectReferences({ project, allProjects });
  }

  if (!artifactType || artifactType === 'docker') {
    const { verifyDockerImageTags } = await import('./docker.js');
    await verifyDockerImageTags({ project, allProjects });
  }
}

/**
 * Restore original project files after packing
 */
export async function restoreProjectFiles(projectCwd: string): Promise<void> {
  // Restore NPM package.json
  const { restorePackageJson } = await import('./npm.js');
  await restorePackageJson(projectCwd).catch(() => {});

  // Restore NuGet .csproj files
  const { restoreCsprojFiles } = await import('./nuget.js');
  await restoreCsprojFiles(projectCwd).catch(() => {});
}
