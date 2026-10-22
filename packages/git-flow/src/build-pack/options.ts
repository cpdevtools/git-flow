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
      } else if (trimmed.startsWith('releaseId:')) {
        const id = parseInt(trimmed.split(':')[1].trim(), 10);
        if (Number.isInteger(id) && id > 0) currentProject.releaseId = id;
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

/**
 * Write (or replace) a `releaseId:` line under each named project in the PR
 * body's YAML metadata block. Everything else in the body — the Force Rebuild
 * checkbox, the projects table, prose — is left byte-for-byte as it was.
 *
 * Projects not in `ids` keep whatever `releaseId:` they already had. Returns
 * the body unchanged when there is no YAML block or nothing to write.
 */
export function setReleaseIdsInPRBody(prBody: string, ids: Record<string, number>): string {
  const names = Object.keys(ids);
  if (names.length === 0) return prBody;

  const blockMatch = prBody.match(/```yaml\s*\n([\s\S]*?)\n```/);
  if (!blockMatch || blockMatch.index === undefined) return prBody;

  const lines = blockMatch[1].split('\n');
  const out: string[] = [];
  // The project whose fields the current line belongs to, once a `- name:`
  // line has been seen; cleared by the next `- name:` or any line indented
  // less than the project's fields (the next placeholder, `projects:`).
  let current: { name: string; indent: string } | null = null;

  for (const line of lines) {
    const nameMatch = line.match(/^(\s*)- name:\s*(.+?)\s*$/);
    if (nameMatch) {
      current = { name: nameMatch[2], indent: `${nameMatch[1]}  ` };
      out.push(line);
      if (ids[current.name] !== undefined) out.push(`${current.indent}releaseId: ${ids[current.name]}`);
      continue;
    }
    if (current) {
      if (line.trim() !== '' && !line.startsWith(current.indent)) {
        current = null;
      } else if (line.trim().startsWith('releaseId:') && ids[current.name] !== undefined) {
        continue; // superseded by the line written under `- name:`
      }
    }
    out.push(line);
  }

  const start = blockMatch.index + blockMatch[0].indexOf(blockMatch[1]);
  const end = start + blockMatch[1].length;
  return prBody.slice(0, start) + out.join('\n') + prBody.slice(end);
}
