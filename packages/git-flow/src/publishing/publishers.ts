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

    // Verify digest matches
    const actualDigest = (
      await $`docker inspect --format='{{.Id}}' ${fullTempImage}`
    ).stdout.trim();

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

    // TODO: Delete temp tag from remote registry
    // This is registry-specific and can be added later
    // For now, temp tags will remain in the registry
  } finally {
    await $`docker logout ${registry.registry}`.catch(() => {
      // Best effort logout
    });
  }
}
