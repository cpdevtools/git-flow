import { execSync } from 'node:child_process';
import type { ChangeDetectionOptions, LastPassTag, TagType, TestMode } from './types.js';
import type { Project } from '../lib/project.js';

/**
 * Build the git tag name for a project/branch/tagType combination.
 * Sanitizes the branch name so it's safe for use in a git ref.
 */
export function getTagName(branch: string, projectName: string, tagType: TagType): string {
  const safeBranch = branch.replace(/[^a-zA-Z0-9._\-/]/g, '-');
  return `test-pass/${safeBranch}/${projectName}/${tagType}`;
}

/**
 * Retrieve the last-pass tag for a project on the current branch, if it exists.
 * Returns null when the tag doesn't exist (no prior successful run on this branch).
 */
export async function getLastPassTag(options: ChangeDetectionOptions): Promise<LastPassTag | null> {
  const { branch, project, tagType, workspaceRoot } = options;
  const tagName = getTagName(branch, project.name, tagType);

  try {
    const sha = execSync(`git rev-list -n 1 "refs/tags/${tagName}" 2>/dev/null`, {
      cwd: workspaceRoot,
      encoding: 'utf-8',
    }).trim();

    if (!sha) return null;
    return { tag: tagName, sha, source: 'current-branch' };
  } catch {
    return null;
  }
}

/**
 * Returns true when any tracked files inside the project directory changed since
 * the last recorded pass tag, or when no tag exists.
 */
export async function hasProjectChanged(options: ChangeDetectionOptions): Promise<boolean> {
  const lastTag = await getLastPassTag(options);

  if (!lastTag) {
    // No tag = project has never passed on this branch → run it
    return true;
  }

  try {
    const changes = execSync(
      `git diff --name-only "${lastTag.sha}" HEAD -- "${options.project.directory}"`,
      { cwd: options.workspaceRoot, encoding: 'utf-8' },
    ).trim();

    return changes.length > 0;
  } catch {
    // If diff fails for any reason, be conservative and run the project
    return true;
  }
}

/**
 * Create / update the pass tag for a project and push it to origin.
 * Uses --force so the tag moves forward with each successful run.
 */
export async function recordTestPass(
  workspaceRoot: string,
  project: Project,
  branch: string,
  tagType: TagType,
  sha: string,
): Promise<void> {
  const tagName = getTagName(branch, project.name, tagType);

  execSync(`git tag -f "${tagName}" ${sha}`, { cwd: workspaceRoot });
  execSync(
    `git push origin "refs/tags/${tagName}:refs/tags/${tagName}" --force`,
    { cwd: workspaceRoot },
  );
}

/** Returns the SHA of HEAD in the given workspace. */
export async function getCurrentSHA(workspaceRoot: string): Promise<string> {
  return execSync('git rev-parse HEAD', { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
}

/**
 * Maps a test mode to the tag types that must be checked / written for it.
 */
export function getTagTypesForMode(mode: TestMode): TagType[] {
  if (mode === 'build') return ['build'];
  if (mode === 'test') return ['test'];
  return ['build', 'test']; // test-optional checks/writes both
}
