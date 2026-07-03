import { $ } from 'zx';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { NpmRegistry, NugetRegistry, DockerRegistry, VerificationResult } from './types.js';

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
 * Check if a package version is published to NuGet registry
 */
export async function isNugetPublished(
  packageId: string,
  version: string,
  registry: NugetRegistry,
): Promise<VerificationResult> {
  try {
    // Use NuGet HTTP API to check if version exists
    const serviceUrl = registry.url.endsWith('/v3/index.json')
      ? registry.url
      : `${registry.url}/v3/index.json`;

    const response = await fetch(serviceUrl);
    if (!response.ok) {
      throw new Error(`Failed to query NuGet service: ${response.statusText}`);
    }

    // This is a simplified check - full implementation would follow NuGet protocol
    // For now, we'll use dotnet CLI
    const result = await $`dotnet list package --source ${registry.url} | grep ${packageId}`;

    return {
      published: result.stdout.includes(version),
      version,
    };
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
): Promise<VerificationResult> {
  try {
    const fullImageName = registry.namespace
      ? `${registry.registry}/${registry.namespace}/${imageName}:${tag}`
      : `${registry.registry}/${imageName}:${tag}`;

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
      return isNugetPublished(artifactName, version, registry);

    case 'docker':
      return isDockerPublished(artifactName, version, registry);

    default:
      throw new Error(`Unknown registry type: ${(registry as unknown as { type: string }).type}`);
  }
}
