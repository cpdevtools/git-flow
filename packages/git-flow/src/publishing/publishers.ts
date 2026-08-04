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
 * Authenticate the docker CLI against a registry.
 *
 * Private and internal images need credentials to *read* as well as to push, so
 * verification uses this too.
 */
export async function dockerLogin(
  registry: DockerRegistry,
  token: string,
  username?: string,
): Promise<void> {
  // GHCR (and most registries) require a username alongside --password-stdin;
  // fall back to the Actions actor when no username env is configured.
  const loginUser =
    username ??
    (registry.usernameEnv ? process.env[registry.usernameEnv] : undefined) ??
    process.env.GITHUB_ACTOR;

  if (loginUser) {
    await $`echo ${token} | docker login ${registry.registry} -u ${loginUser} --password-stdin`;
  } else {
    await $`echo ${token} | docker login ${registry.registry} --password-stdin`;
  }
}

/**
 * Drop docker credentials for a registry. Best effort.
 */
export async function dockerLogout(registry: DockerRegistry): Promise<void> {
  await $`docker logout ${registry.registry}`.catch(() => {
    // Best effort logout
  });
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

  // Add --provenance when OIDC is available (GitHub Actions with id-token: write)
  // --access public is required for scoped packages with provenance
  const provenance = !!process.env.ACTIONS_ID_TOKEN_REQUEST_URL;

  try {
    if (prereleaseTag && provenance) {
      await $`npm publish ${artifactPath} --registry ${registry.url} --tag ${prereleaseTag} --provenance --access public`;
    } else if (prereleaseTag) {
      await $`npm publish ${artifactPath} --registry ${registry.url} --tag ${prereleaseTag}`;
    } else if (provenance) {
      await $`npm publish ${artifactPath} --registry ${registry.url} --provenance --access public`;
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
 *
 * The image is transported between the build-pack and publish jobs as a gzipped
 * tarball artifact (produced by `docker save` during pack) rather than a
 * transient registry tag. This keeps the registry free of throwaway `temp-*`
 * tags: the image only ever appears under its final release/`latest` tags.
 */
export async function publishToDocker(options: DockerPublishOptions): Promise<void> {
  const { imageName, archivePath, finalTag, digest, registry, username, token } = options;

  // Load the image from the tarball artifact produced during pack.
  await $`docker load -i ${archivePath}`;

  // Verify the loaded image matches the digest captured at pack time. The image
  // config id (.Id) is stable across docker save/load, so we compare against it.
  const actualDigest = (await $`docker inspect --format='{{.Id}}' ${digest}`.nothrow()).stdout
    .trim()
    .replace(/^'|'$/g, '');

  if (actualDigest !== digest) {
    throw new Error(
      `Docker image digest mismatch!\n` +
        `Expected: ${digest}\n` +
        `Actual:   ${actualDigest || '(image not found after load)'}\n` +
        `This may indicate the image archive was modified after being built.`,
    );
  }

  await dockerLogin(registry, token, username);

  try {
    // Build final image name with namespace if provided
    const finalImageBase = resolveDockerImageBase(imageName, registry);

    const finalVersionImage = `${finalImageBase}:${finalTag}`;
    const finalLatestImage = `${finalImageBase}:latest`;

    // Tag the loaded image (referenced by its id) with the final tags and push.
    await $`docker tag ${digest} ${finalVersionImage}`;
    await $`docker tag ${digest} ${finalLatestImage}`;

    await $`docker push ${finalVersionImage}`;
    await $`docker push ${finalLatestImage}`;

    // Best-effort local cleanup of the tags we created.
    await $`docker rmi ${finalVersionImage} ${finalLatestImage}`.catch(() => {
      // Ignore errors - cleanup is best-effort
    });
  } finally {
    await dockerLogout(registry);
  }
}
