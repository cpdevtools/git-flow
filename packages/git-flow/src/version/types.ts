/**
 * Version resolution types
 */

export interface VersionResolutionInput {
  /** Version placeholder from package.json (e.g., "0.0.0-DEFAULT") */
  placeholder: string;

  /** Current branch name */
  branch: string;

  /** Map of placeholders to resolved versions */
  versionsByPlaceholder: Record<string, string>;

  /** CI run number for build suffix */
  runNumber?: number;
}

export interface ResolvedVersion {
  /** Original placeholder from package.json */
  placeholder: string;

  /** Version after placeholder resolution */
  resolvedVersion: string;

  /** Final version after all transformations */
  version: string;

  /** Whether the final version is a pre-release */
  isPreRelease: boolean;

  /** Build number if appended */
  buildNumber?: number;

  /** Branch type: mainline or development */
  branchType: 'mainline' | 'development';
}
