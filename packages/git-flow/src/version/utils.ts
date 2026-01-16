import * as semver from 'semver';

/**
 * Determine if a version string is a pre-release
 * @param version - Semantic version string
 * @returns True if version is a pre-release
 */
export function isPreRelease(version: string): boolean {
  const parsed = semver.parse(version);
  return parsed ? parsed.prerelease.length > 0 : false;
}

/**
 * Sanitize branch name for use in version string
 * Replaces slashes and special characters with dots
 * 
 * @param branch - Branch name to sanitize
 * @returns Sanitized branch name
 * 
 * @example
 * sanitizeBranchName('feature/new-feature') // "feature.new-feature"
 * sanitizeBranchName('team/feature/auth') // "team.feature.auth"
 */
export function sanitizeBranchName(branch: string): string {
  return branch.replace(/\//g, '.').replace(/[^a-zA-Z0-9.-]/g, '.');
}

/**
 * Determine branch type: mainline or development
 * Mainline branches do NOT contain a forward slash
 * 
 * @param branch - Branch name
 * @returns Branch type
 * 
 * @example
 * getBranchType('main') // 'mainline'
 * getBranchType('feature/auth') // 'development'
 */
export function getBranchType(branch: string): 'mainline' | 'development' {
  return isMainlineBranch(branch) ? 'mainline' : 'development';
}

/**
 * Determine if a branch is a mainline branch
 * Mainline branches do NOT contain a forward slash
 * 
 * @param branch - Branch name
 * @returns True if branch is mainline
 * 
 * @example
 * isMainlineBranch('main') // true
 * isMainlineBranch('v1.8') // true
 * isMainlineBranch('feature/auth') // false
 */
export function isMainlineBranch(branch: string): boolean {
  return !branch.includes('/');
}

/**
 * Extract base version and pre-release parts from a semver string
 * @param version - Semantic version string
 * @returns Object with base version and prerelease parts
 */
export function extractVersionParts(version: string): {
  base: string;
  prerelease: string[];
} {
  const parsed = semver.parse(version);
  if (!parsed) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  return {
    base: `${parsed.major}.${parsed.minor}.${parsed.patch}`,
    prerelease: parsed.prerelease.map(String),
  };
}

/**
 * Build a version string from base and prerelease parts
 * @param base - Base version (e.g., "2.0.0")
 * @param prerelease - Prerelease identifiers
 * @returns Complete version string
 */
export function buildVersion(base: string, prerelease: string[]): string {
  if (prerelease.length === 0) {
    return base;
  }
  return `${base}-${prerelease.join('.')}`;
}
