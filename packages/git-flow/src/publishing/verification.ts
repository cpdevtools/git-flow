import { $ } from 'zx';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { NpmRegistry, NugetRegistry, DockerRegistry, VerificationResult } from './types.js';
import { dockerLogin, dockerLogout, resolveDockerImageBase } from './publishers.js';

/**
 * Check if a package version is published to NPM registry
 * Note: GitHub Packages requires authentication even to read packages
 */
export async function isNpmPublished(
  packageName: string,
  version: string,
  registry: NpmRegistry,
  token?: string,
): Promise<VerificationResult> {
  const npmrcPath = join(homedir(), '.npmrc');
  let npmrcCreated = false;

  try {
    console.log(`  📋 Checking if ${packageName}@${version} exists in ${registry.url}...`);

    // If token provided, set up .npmrc for auth (GitHub Packages requires auth even for reads)
    if (token) {
      const registryUrl = new URL(registry.url);
      const registryPath = registryUrl.pathname.endsWith('/')
        ? registryUrl.pathname
        : registryUrl.pathname + '/';
      let npmrcContent = `//${registryUrl.host}${registryPath}:_authToken=${token}\n`;
      if (registry.scope) {
        npmrcContent += `${registry.scope}:registry=${registry.url}\n`;
      }
      await writeFile(npmrcPath, npmrcContent);
      npmrcCreated = true;
    }

    // Build args array for proper argument handling
    const args = [
      'view',
      `${packageName}@${version}`,
      'version',
      '--registry',
      registry.url,
      '--json',
    ];

    const result = await $`npm ${args}`.nothrow();

    console.log(
      `  📋 npm view exit code: ${result.exitCode}, stdout: ${result.stdout.trim().substring(0, 100)}`,
    );

    if (result.exitCode !== 0) {
      // Check if it's a package not found error
      const stderr = result.stderr || '';
      const stdout = result.stdout || '';
      if (
        stderr.includes('404') ||
        stderr.includes('E404') ||
        stdout.includes('E404') ||
        stderr.includes('not found')
      ) {
        return {
          published: false,
          error: 'Package not found in registry',
        };
      }
      // For other errors, return the actual error
      return {
        published: false,
        error: result.stderr || 'Unknown error checking registry',
      };
    }

    // Parse JSON output (npm view returns quoted string or null)
    const output = result.stdout.trim();
    const publishedVersion = output.replace(/^"|"$/g, '');

    return {
      published: publishedVersion === version,
      version: publishedVersion,
    };
  } catch (error) {
    // npm view returns error if package/version doesn't exist
    console.log(`  ⚠️ npm view error: ${error}`);
    return {
      published: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Clean up .npmrc if we created it
    if (npmrcCreated) {
      await unlink(npmrcPath).catch(() => {});
    }
  }
}

/**
 * Check if a package version is published to a NuGet registry, via the NuGet
 * v3 protocol: service index → PackageBaseAddress resource → the package's
 * version list at `{base}/{lowercase-id}/index.json`.
 *
 * Auth matters: GitHub Packages returns 404 for ANONYMOUS requests to
 * everything, including the service index — an unauthenticated check reads as
 * "service not found" even when the registry is fine (this failed shop-in-shop's
 * first-ever dotnet-lib publish). Basic auth with the token as password is the
 * scheme `dotnet nuget push --api-key` maps to on GitHub Packages.
 */
export async function isNugetPublished(
  packageId: string,
  version: string,
  registry: NugetRegistry,
  token?: string,
): Promise<VerificationResult> {
  try {
    const serviceUrl = registry.url.endsWith('/index.json')
      ? registry.url
      : `${registry.url.replace(/\/$/, '')}/v3/index.json`;

    const headers: Record<string, string> = token
      ? { Authorization: `Basic ${Buffer.from(`token:${token}`).toString('base64')}` }
      : {};

    const indexResponse = await fetch(serviceUrl, { headers });
    if (!indexResponse.ok) {
      throw new Error(`Failed to query NuGet service index: ${indexResponse.statusText}`);
    }

    const index = (await indexResponse.json()) as {
      resources?: { '@id': string; '@type': string }[];
    };
    const baseResource = index.resources?.find((r) =>
      r['@type'].startsWith('PackageBaseAddress/'),
    );
    if (!baseResource) {
      throw new Error('NuGet service index has no PackageBaseAddress resource');
    }

    const base = baseResource['@id'].replace(/\/$/, '');
    const versionsResponse = await fetch(
      `${base}/${packageId.toLowerCase()}/index.json`,
      { headers },
    );

    if (versionsResponse.status === 404) {
      // The package has never been published — expected before a first publish.
      return { published: false, error: 'Package not found in registry' };
    }
    if (!versionsResponse.ok) {
      throw new Error(`Failed to query NuGet package versions: ${versionsResponse.statusText}`);
    }

    const { versions = [] } = (await versionsResponse.json()) as { versions?: string[] };
    const published = versions.some((v) => v.toLowerCase() === version.toLowerCase());

    return { published, version };
  } catch (error) {
    return {
      published: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if a Docker image tag is published to registry
 */
export async function isDockerPublished(
  imageName: string,
  tag: string,
  registry: DockerRegistry,
  token?: string,
): Promise<VerificationResult> {
  let authenticated = false;

  try {
    const fullImageName = `${resolveDockerImageBase(imageName, registry)}:${tag}`;

    // Reading a private/internal manifest anonymously fails as `unauthorized`,
    // which is indistinguishable from "not published" — so authenticate first.
    if (token) {
      await dockerLogin(registry, token);
      authenticated = true;
    }

    // Try to inspect the remote image manifest
    await $`docker manifest inspect ${fullImageName}`;

    return {
      published: true,
      version: tag,
    };
  } catch (error) {
    return {
      published: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (authenticated) {
      await dockerLogout(registry);
    }
  }
}

/**
 * Verify publication of any artifact type
 */
export async function verifyPublication(
  artifactName: string,
  version: string,
  registry: NpmRegistry | NugetRegistry | DockerRegistry,
  token?: string,
): Promise<VerificationResult> {
  switch (registry.type) {
    case 'npm':
      return isNpmPublished(artifactName, version, registry, token);

    case 'nuget':
      return isNugetPublished(artifactName, version, registry, token);

    case 'docker':
      return isDockerPublished(artifactName, version, registry, token);

    default:
      throw new Error(`Unknown registry type: ${(registry as unknown as { type: string }).type}`);
  }
}
