import type { VersionResolutionInput, ResolvedVersion } from './types.js';
import {
  isPreRelease,
  sanitizeBranchName,
  isMainlineBranch,
  extractVersionParts,
  buildVersion,
} from './utils.js';
import { $ } from 'zx';

// Suppress zx output
$.verbose = false;

/**
 * Build the tag name for a project version
 * Format: {projectName}/v{version} for scoped, or v{version} for unscoped
 */
function buildTagName(version: string, projectName?: string): string {
  if (projectName) {
    return `${projectName}/v${version}`;
  }
  return `v${version}`;
}

/**
 * Check if a version is already released (git tag or GitHub release exists)
 * Checks in order:
 * 1. Git tags (local and remote)
 * 2. GitHub releases (including drafts) by tag name
 */
async function tagExists(tag: string): Promise<boolean> {
  try {
    console.log(`[tagExists] Checking tag: ${tag}`);
    
    // First try local git tag
    const localResult = await $`git tag -l ${tag}`.nothrow();
    console.log(`[tagExists] Local git tag result: "${localResult.stdout.trim()}" (expected: "${tag}")`);
    if (localResult.stdout.trim() === tag) {
      console.log(`[tagExists] Found local git tag: ${tag}`);
      return true;
    }
    
    // Check remote tags (for CI where local might not have all tags)
    const remoteResult = await $`git ls-remote --tags origin refs/tags/${tag}`.nothrow();
    console.log(`[tagExists] Remote git tag result: "${remoteResult.stdout.trim().substring(0, 100)}"`);
    if (remoteResult.stdout.trim().length > 0) {
      console.log(`[tagExists] Found remote git tag: ${tag}`);
      return true;
    }

    // Check GitHub releases by tag name (catches draft releases too)
    // gh release view returns exit code 0 if release exists, 1 if not
    console.log(`[tagExists] Checking GitHub release: gh release view ${tag} --json tagName`);
    const releaseResult = await $`gh release view ${tag} --json tagName`.nothrow();
    console.log(`[tagExists] GitHub release result: exitCode=${releaseResult.exitCode}, stdout="${releaseResult.stdout.trim().substring(0, 100)}"`);
    if (releaseResult.exitCode === 0) {
      console.log(`[tagExists] Found GitHub release: ${tag}`);
      return true;
    }

    console.log(`[tagExists] Tag not found: ${tag}`);
    return false;
  } catch (error) {
    console.warn(`Warning: Failed to check tag ${tag}: ${error}`);
    return false;
  }
}

/**
 * Resolve version based on placeholder, branch, and run number
 * Implements the complete version resolution algorithm
 * 
 * @param input - Version resolution input parameters
 * @returns Resolved version information
 * 
 * @example
 * ```typescript
 * const result = await resolveVersion({
 *   placeholder: '0.0.0-DEFAULT',
 *   branch: 'main',
 *   versionsByPlaceholder: { '0.0.0-DEFAULT': '2.0.0' },
 *   runNumber: 123,
 * });
 * // result.version might be "2.0.0" or "2.0.0-main.build.123"
 * ```
 */
export async function resolveVersion(input: VersionResolutionInput): Promise<ResolvedVersion> {
  const { placeholder, branch, versionsByPlaceholder, runNumber, projectName } = input;

  // Step 1: Resolve placeholder
  const resolvedVersion = versionsByPlaceholder[placeholder];
  if (!resolvedVersion) {
    throw new Error(`No version found for placeholder: ${placeholder}`);
  }

  const branchType = isMainlineBranch(branch) ? 'mainline' : 'development';

  // Process based on branch type
  if (branchType === 'mainline') {
    return await resolveMainlineBranch({
      placeholder,
      resolvedVersion,
      branch,
      runNumber,
      projectName,
    });
  } else {
    return await resolveDevelopmentBranch({
      placeholder,
      resolvedVersion,
      branch,
      runNumber,
      projectName,
    });
  }
}

/**
 * Resolve version for mainline branches
 */
async function resolveMainlineBranch(params: {
  placeholder: string;
  resolvedVersion: string;
  branch: string;
  runNumber?: number;
  projectName?: string;
}): Promise<ResolvedVersion> {
  const { placeholder, resolvedVersion, branch, runNumber, projectName } = params;

  // Check if tag exists (per-project format: {projectName}/v{version})
  const tag = buildTagName(resolvedVersion, projectName);
  const hasTag = await tagExists(tag);

  let version: string;
  let finalIsPreRelease: boolean;
  let buildNumber: number | undefined;

  if (!hasTag) {
    // Tag doesn't exist - use resolved version as-is
    version = resolvedVersion;
    finalIsPreRelease = isPreRelease(resolvedVersion);
  } else {
    // Tag exists - append suffix based on whether resolved version is pre-release
    const resolvedIsPreRelease = isPreRelease(resolvedVersion);
    const sanitizedBranch = sanitizeBranchName(branch);

    if (resolvedIsPreRelease) {
      // Pre-release: append .build.N
      version = runNumber
        ? `${resolvedVersion}.build.${runNumber}`
        : `${resolvedVersion}.build.0`;
    } else {
      // Stable: append -branch.build.N
      version = runNumber
        ? `${resolvedVersion}-${sanitizedBranch}.build.${runNumber}`
        : `${resolvedVersion}-${sanitizedBranch}.build.0`;
    }

    finalIsPreRelease = true;
    buildNumber = runNumber ?? 0;
  }

  return {
    placeholder,
    resolvedVersion,
    version,
    isPreRelease: finalIsPreRelease,
    buildNumber,
    branchType: 'mainline',
  };
}

/**
 * Resolve version for development branches
 */
async function resolveDevelopmentBranch(params: {
  placeholder: string;
  resolvedVersion: string;
  branch: string;
  runNumber?: number;
  projectName?: string;
}): Promise<ResolvedVersion> {
  const { placeholder, resolvedVersion, branch, runNumber, projectName } = params;

  const sanitizedBranch = sanitizeBranchName(branch);
  const resolvedIsPreRelease = isPreRelease(resolvedVersion);

  let versionWithBranch: string;

  if (resolvedIsPreRelease) {
    // Extract base and prerelease, insert branch name before prerelease
    const { base, prerelease } = extractVersionParts(resolvedVersion);
    versionWithBranch = buildVersion(base, [sanitizedBranch, ...prerelease]);
  } else {
    // Stable version - append branch as prerelease
    versionWithBranch = `${resolvedVersion}-${sanitizedBranch}`;
  }

  // Check if tag exists for version with branch (per-project format)
  const tag = buildTagName(versionWithBranch, projectName);
  const hasTag = await tagExists(tag);

  let version: string;
  let buildNumber: number | undefined;

  if (!hasTag) {
    // Tag doesn't exist - use version with branch as-is
    version = versionWithBranch;
  } else {
    // Tag exists - append .build.N
    version = runNumber
      ? `${versionWithBranch}.build.${runNumber}`
      : `${versionWithBranch}.build.0`;
    buildNumber = runNumber ?? 0;
  }

  return {
    placeholder,
    resolvedVersion,
    version,
    isPreRelease: true, // Development branches are always pre-release
    buildNumber,
    branchType: 'development',
  };
}
