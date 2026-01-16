import type { VersionResolutionInput, ResolvedVersion } from './types.js';
import {
  isPreRelease,
  sanitizeBranchName,
  isMainlineBranch,
  extractVersionParts,
  buildVersion,
} from './utils.js';

/**
 * Check if a git tag exists
 * Note: This is a placeholder - actual implementation would use git commands
 * For now, returns false to simulate no tag exists
 */
async function tagExists(_tag: string): Promise<boolean> {
  // TODO: Implement actual git tag check
  // For phase 1, we'll simulate this
  return false;
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
  const { placeholder, branch, versionsByPlaceholder, runNumber } = input;

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
    });
  } else {
    return await resolveDevelopmentBranch({
      placeholder,
      resolvedVersion,
      branch,
      runNumber,
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
}): Promise<ResolvedVersion> {
  const { placeholder, resolvedVersion, branch, runNumber } = params;

  // Check if tag exists
  const tag = `v${resolvedVersion}`;
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
}): Promise<ResolvedVersion> {
  const { placeholder, resolvedVersion, branch, runNumber } = params;

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

  // Check if tag exists for version with branch
  const tag = `v${versionWithBranch}`;
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
