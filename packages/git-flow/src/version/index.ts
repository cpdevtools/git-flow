/**
 * Version resolution module
 * Resolve version placeholders based on branch and run number
 */

export { resolveVersion } from './resolve.js';
export type { VersionResolutionInput, ResolvedVersion } from './types.js';
export {
  isPreRelease,
  sanitizeBranchName,
  isMainlineBranch,
  getBranchType,
  extractVersionParts,
  buildVersion,
} from './utils.js';
