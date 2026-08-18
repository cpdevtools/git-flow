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
 * Check if a version is already published
 * Checks in order:
 * 1. Git tags (indicates a published release)
 * 2. GitHub release body - checks if ANY artifact has published:true or missing published field
 */
/**
 * Whether a DRAFT release's body proves its version is consumed.
 *
 * A draft is an in-flight release attempt, not a consumed version: the tag only
 * comes into existence when the draft is finalized, and versionExists's tag
 * checks are what detect that. A draft with published:true artifacts is a
 * PARTIAL publish (e.g. npm/nuget landed, the docker bundle failed) — the
 * version must stay resumable, or every failed pack burns the version and the
 * next release PR silently bumps to .build.N. Resuming is safe: publish-release
 * skips per artifact via registry verification, and per project via the
 * finalized-release check.
 *
 * The one case treated as consumed: artifacts with no published flags at all —
 * a draft from before the flag existed, where nothing can prove what shipped.
 */
export function draftBodyConsumesVersion(body: string): boolean {
  const yamlMatch = body.match(/```yaml\s*\n([\s\S]*?)\n\s*```/);
  if (!yamlMatch) {
    return false;
  }

  const yaml = yamlMatch[1];
  const hasPublishedField = /published:\s*(true|false)/i.test(yaml);
  const hasArtifacts = /artifacts:/i.test(yaml);

  if (hasArtifacts && !hasPublishedField) {
    console.log(
      `[versionExists] Found artifacts without published field, assuming version taken`,
    );
    return true;
  }

  console.log(`[versionExists] Draft release is in-flight (resumable), version not consumed`);
  return false;
}

export async function versionExists(version: string, projectName?: string): Promise<boolean> {
  try {
    console.log(
      `[versionExists] Checking version: ${version} for project: ${projectName || 'unknown'}`,
    );

    // Build tag name for git check
    const tag = buildTagName(version, projectName);

    // First try local git tag
    const localResult = await $`git tag -l ${tag}`.nothrow();
    console.log(
      `[versionExists] Local git tag result: "${localResult.stdout.trim()}" (expected: "${tag}")`,
    );
    if (localResult.stdout.trim() === tag) {
      console.log(`[versionExists] Found local git tag: ${tag}`);
      return true;
    }

    // Check remote tags (for CI where local might not have all tags)
    const remoteResult = await $({
      timeout: 10000,
    })`git ls-remote --tags origin refs/tags/${tag}`.nothrow();
    console.log(
      `[versionExists] Remote git tag result: "${remoteResult.stdout.trim().substring(0, 100)}"`,
    );
    if (remoteResult.stdout.trim().length > 0) {
      console.log(`[versionExists] Found remote git tag: ${tag}`);
      return true;
    }

    // Check GitHub release body for published artifacts
    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_REPOSITORY_OWNER;
    const repoWithOwner = process.env.GITHUB_REPOSITORY;
    const repo = repoWithOwner?.split('/')[1];

    if (token && owner && repo) {
      console.log(`[versionExists] Checking GitHub release body for ${tag}`);
      $.env = { ...process.env, GITHUB_TOKEN: token };
      const ghResult =
        await $`gh api repos/${owner}/${repo}/releases --jq '.[] | select(.tag_name == "${tag}" or .name == "${projectName} ${version}") | select(.draft == true) | .body'`.nothrow();

      if (ghResult.exitCode === 0 && ghResult.stdout.trim()) {
        if (draftBodyConsumesVersion(ghResult.stdout.trim())) {
          return true;
        }
      }
    }

    console.log(`[versionExists] Version not found: ${version}`);
    return false;
  } catch (error) {
    console.warn(`Warning: Failed to check version ${version}: ${error}`);
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
 *   placeholder: '0.0.0-MAIN',
 *   branch: 'main',
 *   versionsByPlaceholder: { '0.0.0-MAIN': '2.0.0' },
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

  // Check if version already exists (git tag or npm registry)
  const hasVersion = await versionExists(resolvedVersion, projectName);

  let version: string;
  let finalIsPreRelease: boolean;
  let buildNumber: number | undefined;

  if (!hasVersion) {
    // Tag doesn't exist - use resolved version as-is
    version = resolvedVersion;
    finalIsPreRelease = isPreRelease(resolvedVersion);
  } else {
    // Tag exists - append suffix based on whether resolved version is pre-release
    const resolvedIsPreRelease = isPreRelease(resolvedVersion);
    const sanitizedBranch = sanitizeBranchName(branch);

    if (resolvedIsPreRelease) {
      // Pre-release: append .build.N
      version = runNumber ? `${resolvedVersion}.build.${runNumber}` : `${resolvedVersion}.build.0`;
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
  const hasTag = await versionExists(versionWithBranch, projectName);

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
