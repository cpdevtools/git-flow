/**
 * Parse release metadata from PR body
 */

import type { PRMetadata, PRProjectMetadata } from './types.js';

/**
 * Extract YAML metadata block from PR body
 * @param prBody - Full PR body text
 * @returns Parsed metadata
 */
export function extractPRMetadata(prBody: string): PRMetadata {
  // Check for Force Rebuild checkbox
  const forceRebuildMatch = prBody.match(/- \[(x|X)\] Force Rebuild/);
  const forceRebuild = !!forceRebuildMatch;

  // Find YAML block between ```yaml and ```
  const yamlMatch = prBody.match(/```yaml\s*\n([\s\S]*?)\n```/);

  if (!yamlMatch) {
    throw new Error('PR body does not contain required YAML metadata block');
  }

  const yamlContent = yamlMatch[1];

  // Parse YAML organized by placeholder
  const lines = yamlContent.split('\n');
  const projectsByPlaceholder: Record<string, PRProjectMetadata[]> = {};
  let currentPlaceholder: string | null = null;
  let currentProject: Partial<PRProjectMetadata> | null = null;
  let inProjects = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Match placeholder key (e.g., "MAIN:", "V1_8_LTS:")
    if (trimmed.match(/^[A-Z0-9_]+:$/)) {
      currentPlaceholder = trimmed.slice(0, -1); // Remove trailing colon
      projectsByPlaceholder[currentPlaceholder] = [];
      inProjects = false;
    } else if (trimmed === 'projects:') {
      inProjects = true;
    } else if (inProjects && trimmed.startsWith('- name:')) {
      if (currentProject && currentPlaceholder) {
        currentProject.placeholder = currentPlaceholder;
        projectsByPlaceholder[currentPlaceholder].push(currentProject as PRProjectMetadata);
      }
      currentProject = { name: trimmed.split(':')[1].trim() };
    } else if (currentProject) {
      if (trimmed.startsWith('version:')) {
        currentProject.version = trimmed.split(':')[1].trim();
      } else if (trimmed.startsWith('prerelease:')) {
        currentProject.prerelease = trimmed.split(':')[1].trim() === 'true';
      } else if (trimmed.startsWith('cwd:')) {
        currentProject.cwd = trimmed.split(':')[1].trim();
      }
      // Skip tags: and tag items (- v...) as they're for display only
    }
  }

  // Don't forget the last project
  if (currentProject && currentPlaceholder) {
    currentProject.placeholder = currentPlaceholder;
    projectsByPlaceholder[currentPlaceholder].push(currentProject as PRProjectMetadata);
  }

  if (Object.keys(projectsByPlaceholder).length === 0) {
    throw new Error('Incomplete PR metadata: no projects found');
  }

  return {
    projectsByPlaceholder,
    forceRebuild,
  } as PRMetadata;
}
