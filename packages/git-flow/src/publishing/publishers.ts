import { writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import * as semver from 'semver';
import { $ } from 'zx';
import type {
  NpmPublishOptions,
  NugetPublishOptions,
  DockerPublishOptions,
  DockerRegistry,
} from './types.js';
import { isFloatingEligible } from './floating-tags.js';

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
 * Substrings/patterns in a failed `docker push`'s output that indicate a
 * transient, retryable condition rather than a genuine auth/config failure.
 *
 * GHCR is the main offender: pushing a large multi-layer image issues many blob
 * writes in a short window, and GitHub's *secondary rate limit* rejects the tail
 * of that burst with a confusing `403 "permission_denied"` whose body actually
 * reads "You have exceeded a secondary rate limit". Network blips (timeouts,
 * resets, 5xx) are retryable too.
 */
const TRANSIENT_PUSH_PATTERNS: RegExp[] = [
  /secondary rate limit/i,
  /\btoomanyrequests\b/i,
  /rate limit/i,
  /status code 429/i,
  /status code 5\d\d/i,
  /\b(?:500|502|503|504)\b/,
  /i\/o timeout/i,
  /connection reset/i,
  /connection refused/i,
  /unexpected eof/i,
  /tls handshake timeout/i,
  /temporarily unavailable/i,
  // ghcr intermittently fails a layer upload/cross-repo mount mid-push with
  // BLOB_UNKNOWN ("unknown blob" / "blob unknown to registry") while other
  // layers of the same push succeed; the re-push skips the uploaded layers and
  // lands the missing one (observed on shop-in-shop's first image publish).
  /unknown blob/i,
  /blob unknown/i,
];

/**
 * Classify `docker push` output as a transient (retryable) registry error.
 */
export function isTransientRegistryError(output: string): boolean {
  return TRANSIENT_PUSH_PATTERNS.some((pattern) => pattern.test(output));
}

export interface DockerPushRetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Runs a single push attempt. Injectable for tests. */
  push?: (image: string) => Promise<{ exitCode: number | null; output: string }>;
  /** Sleep between attempts. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

async function defaultDockerPush(
  image: string,
): Promise<{ exitCode: number | null; output: string }> {
  const result = await $`docker push ${image}`.nothrow();
  return { exitCode: result.exitCode, output: `${result.stdout}\n${result.stderr}` };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `docker push` with exponential backoff on transient registry failures.
 *
 * Re-pushing is idempotent -- blobs already uploaded are skipped -- so retrying
 * a rate-limited or flaky push is safe and usually succeeds quickly because most
 * layers are already present. Non-transient failures (bad auth, unknown repo)
 * fail immediately so real problems aren't masked by minutes of pointless waits.
 */
export async function dockerPushWithRetry(
  image: string,
  options: DockerPushRetryOptions = {},
): Promise<void> {
  const {
    retries = 5,
    baseDelayMs = 20_000,
    maxDelayMs = 180_000,
    push = defaultDockerPush,
    sleep = defaultSleep,
  } = options;

  for (let attempt = 1; ; attempt++) {
    const { exitCode, output } = await push(image);
    if (exitCode === 0) {
      return;
    }

    if (attempt > retries || !isTransientRegistryError(output)) {
      throw new Error(
        `docker push ${image} failed (exit ${exitCode ?? 'null'}):\n${output.trim()}`,
      );
    }

    const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
    const waitMs = backoff + Math.floor(Math.random() * 1_000);
    console.log(
      `  ⚠️  Transient registry error pushing ${image} ` +
        `(attempt ${attempt}/${retries}); retrying in ${Math.round(waitMs / 1000)}s...`,
    );
    await sleep(waitMs);
  }
}

/**
 * Publish NPM package to registry
 */
export async function publishToNpm(options: NpmPublishOptions): Promise<void> {
  const { artifactPath, registry, token, packageName, version, floatingTags } = options;

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

  // npm insists on a dist-tag at publish and defaults to `latest`, so the tag
  // is always explicit here — `latest` must only move for the highest stable.
  //   - a version that earns pointers publishes under the most important one
  //     and the rest are added afterwards;
  //   - a mainline version that earns none (a maintenance patch behind a newer
  //     line, an alpha older than the current one) parks on `previous` rather
  //     than dragging `latest` or its channel backwards;
  //   - anything else (development-branch and .build.N versions) keeps the
  //     first prerelease identifier as before (`feature`, `dev`, `main`).
  const firstPrereleaseId = String(semver.prerelease(version)?.[0] ?? '') || undefined;
  const publishTag =
    floatingTags[0] ?? (isFloatingEligible(version) ? 'previous' : firstPrereleaseId);

  // Add --provenance when OIDC is available (GitHub Actions with id-token: write)
  // --access public is required for scoped packages with provenance
  const provenance = !!process.env.ACTIONS_ID_TOKEN_REQUEST_URL;

  try {
    if (publishTag && provenance) {
      await $`npm publish ${artifactPath} --registry ${registry.url} --tag ${publishTag} --provenance --access public`;
    } else if (publishTag) {
      await $`npm publish ${artifactPath} --registry ${registry.url} --tag ${publishTag}`;
    } else if (provenance) {
      await $`npm publish ${artifactPath} --registry ${registry.url} --provenance --access public`;
    } else {
      await $`npm publish ${artifactPath} --registry ${registry.url}`;
    }

    // Best effort: the version is published and verified above; a pointer that
    // fails to move is logged with the exact command so it can be re-run by
    // hand. (GitHub Packages' support for `dist-tag add` is not yet proven.)
    for (const tag of floatingTags.slice(1)) {
      const spec = `${packageName}@${version}`;
      try {
        await $`npm dist-tag add ${spec} ${tag} --registry ${registry.url}`;
        console.log(`  🏷️  dist-tag ${tag} → ${version}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `  ⚠️  Could not move dist-tag '${tag}' to ${version}: ${message}\n` +
            `     npm dist-tag add ${spec} ${tag} --registry ${registry.url}`,
        );
      }
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
 * Pack already pushed the image to this registry under a temporary tag
 * (`temp-<sha7>`), so publishing is a promotion: pull that tag, check its
 * config id against the digest captured at pack, and push the same image under
 * the release tag plus whichever floating pointers (`latest`, `next`, a channel)
 * the version earns. Nothing is re-uploaded; the registry already has the layers.
 *
 * The temp tag is left in place. It points at the same manifest as the release
 * tag, and GitHub Packages can only delete a package *version* (the manifest and
 * every tag on it), so removing it would remove the release too.
 */
export async function publishToDocker(options: DockerPublishOptions): Promise<void> {
  const { imageName, tempTag, finalTag, digest, registry, username, token, floatingTags } = options;

  await dockerLogin(registry, token, username);

  try {
    const finalImageBase = resolveDockerImageBase(imageName, registry);
    const tempImage = `${finalImageBase}:${tempTag}`;

    await $`docker pull ${tempImage}`;

    // The image config id (.Id) survives push/pull unchanged, so it identifies
    // the exact image pack built regardless of which registry served it.
    const actualDigest = (await $`docker inspect --format='{{.Id}}' ${tempImage}`.nothrow()).stdout
      .trim()
      .replace(/^'|'$/g, '');

    if (actualDigest !== digest) {
      throw new Error(
        `Docker image digest mismatch for ${tempImage}!\n` +
          `Expected: ${digest}\n` +
          `Actual:   ${actualDigest || '(image not found after pull)'}\n` +
          `The temp tag was overwritten after pack, or pack ran against a different registry.`,
      );
    }

    // The release tag first, then the pointers this version earns. `latest` is
    // one of those, not a given: it only moves for the highest stable release.
    const images = [finalTag, ...floatingTags].map((tag) => `${finalImageBase}:${tag}`);

    for (const image of images) {
      await $`docker tag ${digest} ${image}`;
    }

    // Retry on transient registry failures (GHCR secondary rate limits, network
    // blips). Re-pushing is idempotent, so this is safe.
    for (const image of images) {
      await dockerPushWithRetry(image);
    }

    // Best-effort local cleanup of the tags we created.
    await $`docker rmi ${[tempImage, ...images]}`.catch(() => {
      // Ignore errors - cleanup is best-effort
    });
  } finally {
    await dockerLogout(registry);
  }
}
