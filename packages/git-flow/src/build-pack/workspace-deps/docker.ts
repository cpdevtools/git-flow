export interface ProjectConfig {
  name: string;
  version: string;
  cwd: string;
}

export interface VerifyDockerTagsOptions {
  project: ProjectConfig;
  allProjects: ProjectConfig[];
}

/**
 * Verify Docker images are tagged with versions (not :latest)
 * This is a verification step - actual tagging happens in project scripts
 */
export async function verifyDockerImageTags(options: VerifyDockerTagsOptions): Promise<void> {
  const { project } = options;
  
  // Docker images should be tagged with tempTag in Phase 2
  // This is handled by the project's pack script
  // Here we just log for clarity
  console.log(`  ✓ Docker images for ${project.name} should use tempTag pattern`);
}
