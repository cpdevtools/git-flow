/**
 * Version resolution module
 * Resolve version placeholders based on branch and run number
 */

export { resolveVersion, versionExists } from './resolve.js';
export type { VersionResolutionInput, ResolvedVersion } from './types.js';
export {
  isPreRelease,
  sanitizeBranchName,
  isMainlineBranch,
  getBranchType,
  extractVersionParts,
  buildVersion,
} from './utils.js';
export {
  keyDisplayName,
  computeBumpOptions,
  filterExistingTags,
  type BumpOption,
} from './bumps.js';
export {
  findVersionsFile,
  readVersionsFile,
  writeVersionsFile,
} from './versions-file.js';
