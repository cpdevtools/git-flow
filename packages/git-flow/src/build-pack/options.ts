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

  // Simple YAML parsing (for our controlled format)
  const lines = yamlContent.split('\n');
  const metadata: Partial<PRMetadata> = { projects: [] };
  let currentProject: Partial<PRProjectMetadata> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('- name:')) {
      if (currentProject) {
        metadata.projects!.push(currentProject as PRProjectMetadata);
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
    }
  }

  if (currentProject) {
    metadata.projects!.push(currentProject as PRProjectMetadata);
  }

  if (!metadata.projects || metadata.projects.length === 0) {
    throw new Error('Incomplete PR metadata: no projects found');
  }

  return {
    ...metadata,
    forceRebuild,
  } as PRMetadata;
}
