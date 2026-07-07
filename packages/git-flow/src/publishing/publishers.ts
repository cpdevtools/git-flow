import { getOctokit } from '@actions/github';
import { writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import { $ } from 'zx';
import type {
  NpmPublishOptions,
  NugetPublishOptions,
  DockerPublishOptions,
  DockerRegistry,
} from './types.js';

/**
 * Resolve the fully-qualified docker image base (registry host + namespace + image).
 *
 * Handles both bare image names (e.g. `my-service`) and already fully-qualified
 * names (e.g. `ghcr.io/owner/my-service`) so the registry host/namespace are never
 * prepended twice.
 */
export function resolveDockerImageBase(imageName: string, registry: DockerRegistry): string {
  if (registry.namespace && !imageName.includes('/')) {
    return `${registry.registry}/${registry.namespace}/${imageName}`;
  }
  if (!imageName.includes(registry.registry)) {
    return `${registry.registry}/${imageName}`;
  }
  return imageName;
}

/**
 * Best-effort removal of the transient temp tag from the remote registry.
 *
 * GHCR (via the GitHub Packages API) can only delete an entire package
 * *version* (manifest), not an individual tag. Because the temp tag and the
 * final release/`latest` tags all reference identical image content, they
 * collapse into a single package version — so the temp tag cannot be stripped
 * without deleting the released image.
 *
 * We therefore only reclaim a temp version when it is *orphaned*: tagged
 * exclusively with `temp-*` tags (e.g. left behind by a failed run that never
 * promoted the image). Versions that also carry release/`latest` tags are left
 * untouched. Only GHCR is supported; other registries are skipped.
 */
async function cleanupRemoteTempTag(
  imageName: string,
  tempTag: string,
  registry: DockerRegistry,
  token: string,
): Promise<void> {
  if (!registry.registry.includes('ghcr.io')) {
    return; // Only GHCR temp-tag cleanup is supported.
  }

  // Parse `ghcr.io/<owner>/<package...>` into owner + package name.
  const path = imageName.startsWith(`${registry.registry}/`)
    ? imageName.slice(registry.registry.length + 1)
    : imageName;
  const segments = path.split('/');
  if (segments.length < 2) {
    return; // Not enough information to resolve owner/package.
  }
  const owner = segments[0];
  const packageName = segments.slice(1).join('/');

  const octokit = getOctokit(token);

  // Container packages can be scoped to an org or a user; try org, fall back to user.
  let versions: Array<{ id: number; metadata?: { container?: { tags?: string[] } } }>;
  let scope: 'org' | 'user';
  try {
    const { data } = await octokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg({
      package_type: 'container',
      package_name: packageName,
      org: owner,
      per_page: 100,
    });
    versions = data;
    scope = 'org';
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
    const { data } = await octokit.rest.packages.getAllPackageVersionsForPackageOwnedByUser({
      package_type: 'container',
      package_name: packageName,
      username: owner,
      per_page: 100,
    });
    versions = data;
    scope = 'user';
  }

  const version = versions.find((v) => v.metadata?.container?.tags?.includes(tempTag));
  if (!version) {
    return; // Temp tag no longer present.
  }

  const tags = version.metadata?.container?.tags ?? [];
  const isOrphan = tags.length > 0 && tags.every((t) => t.startsWith('temp-'));
  if (!isOrphan) {
    const releaseTags = tags.filter((t) => !t.startsWith('temp-'));
    console.log(
      `  ℹ️  Temp tag ${tempTag} shares its manifest with release tag(s) ` +
        `${releaseTags.join(', ')}; GHCR cannot delete a single shared tag — leaving in place`,
    );
    return;
  }

  if (scope === 'org') {
    await octokit.rest.packages.deletePackageVersionForOrg({
      package_type: 'container',
      package_name: packageName,
      org: owner,
      package_version_id: version.id,
    });
  } else {
    await octokit.rest.packages.deletePackageVersionForUser({
      package_type: 'container',
      package_name: packageName,
      username: owner,
      package_version_id: version.id,
    });
  }
  console.log(`  🧹 Removed orphaned temp image version (${tempTag})`);
}

/**
 * Publish NPM package to registry
 */
export async function publishToNpm(options: NpmPublishOptions): Promise<void> {
  const { artifactPath, registry, token } = options;

  // Create .npmrc in home directory (where npm looks for auth by default)
  const npmrcPath = join(homedir(), '.npmrc');
  const registryUrl = new URL(registry.url);

  // Include trailing slash for registry path to match npm's expectations
  const registryPath = registryUrl.pathname.endsWith('/')
    ? registryUrl.pathname
    : registryUrl.pathname + '/';
  let npmrcContent = `//${registryUrl.host}${registryPath}:_authToken=${token}\n`;

  if (registry.scope) {
    npmrcContent += `${registry.scope}:registry=${registry.url}\n`;
  }

  console.log(`  📝 Writing .npmrc to ${npmrcPath}`);
  await writeFile(npmrcPath, npmrcContent);

  // Detect prerelease tag from tarball filename (e.g. pkg-1.2.3-dev.0.tgz → 'dev')
  const filenameVersion = basename(artifactPath).match(/(\d+\.\d+\.\d+(?:-.+?)?)\.tgz$/)?.[1];
  const prereleaseTag = filenameVersion?.includes('-')
    ? filenameVersion.split('-')[1].split('.')[0]
    : undefined;

  try {
    if (prereleaseTag) {
      await $`npm publish ${artifactPath} --registry ${registry.url} --tag ${prereleaseTag}`;
    } else {
      await $`npm publish ${artifactPath} --registry ${registry.url}`;
    }
  } finally {
    // Clean up .npmrc
    await $`rm -f ${npmrcPath}`.catch(() => {});
  }
}

/**
 * Publish NuGet package to registry
 */
export async function publishToNuget(options: NugetPublishOptions): Promise<void> {
  const { artifactPath, registry, apiKey } = options;

  await $`dotnet nuget push ${artifactPath} --source ${registry.url} --api-key ${apiKey}`;
}

/**
 * Publish Docker image to registry
 */
export async function publishToDocker(options: DockerPublishOptions): Promise<void> {
  const { imageName, tempTag, finalTag, digest, registry, username, token } = options;

  // Authenticate. GHCR (and most registries) require a username alongside
  // --password-stdin; fall back to the Actions actor when no username env is configured.
  const loginUser = username ?? process.env.GITHUB_ACTOR;
  if (loginUser) {
    await $`echo ${token} | docker login ${registry.registry} -u ${loginUser} --password-stdin`;
  } else {
    await $`echo ${token} | docker login ${registry.registry} --password-stdin`;
  }

  try {
    const fullTempImage = `${imageName}:${tempTag}`;

    // Pull temp image from Phase 2
    await $`docker pull ${fullTempImage}`;

    // Verify digest matches. Pack captures the registry manifest digest
    // (RepoDigests), so we must compare against the same value here — not .Id,
    // which is the image config id and would never match.
    const repoDigestRaw = (
      await $`docker inspect --format='{{index .RepoDigests 0}}' ${fullTempImage}`
    ).stdout.trim();
    const actualDigest = repoDigestRaw.includes('@') ? repoDigestRaw.split('@')[1] : repoDigestRaw;

    if (actualDigest !== digest) {
      throw new Error(
        `Docker image digest mismatch!\n` +
          `Expected: ${digest}\n` +
          `Actual:   ${actualDigest}\n` +
          `This may indicate the image was modified after being built in Phase 2.`,
      );
    }

    // Build final image name with namespace if provided
    const finalImageBase = resolveDockerImageBase(imageName, registry);

    const finalVersionImage = `${finalImageBase}:${finalTag}`;
    const finalLatestImage = `${finalImageBase}:latest`;

    // Retag with final version
    await $`docker tag ${fullTempImage} ${finalVersionImage}`;
    await $`docker tag ${fullTempImage} ${finalLatestImage}`;

    // Push final tags
    await $`docker push ${finalVersionImage}`;
    await $`docker push ${finalLatestImage}`;

    // Delete temp tag from local
    await $`docker rmi ${fullTempImage}`.catch(() => {
      // Ignore errors - cleanup is best-effort
    });

    // Best-effort remote cleanup of the transient temp tag (GHCR only). A temp
    // tag that shares its manifest with the release/latest tags cannot be
    // deleted individually and is intentionally left in place.
    await cleanupRemoteTempTag(imageName, tempTag, registry, token).catch((err) => {
      console.log(
        `  ⚠️  Temp-tag cleanup skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  } finally {
    await $`docker logout ${registry.registry}`.catch(() => {
      // Best effort logout
    });
  }
}
