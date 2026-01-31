import { $ } from 'zx';
import type { NpmRegistry, NugetRegistry, DockerRegistry, VerificationResult } from './types.js';

/**
 * Check if a package version is published to NPM registry
 */
export async function isNpmPublished(
  packageName: string,
  version: string,
  registry: NpmRegistry
): Promise<VerificationResult> {
  try {
    // Use JSON output and explicit registry with scope config for reliability
    const scopeConfig = registry.scope ? `--${registry.scope}:registry=${registry.url}` : '';
    const result = await $`npm view ${packageName}@${version} version --registry ${registry.url} ${scopeConfig} --json`.nothrow();
    
    if (result.exitCode !== 0) {
      // Package doesn't exist yet
      return {
        published: false,
        error: 'Package not found in registry',
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
    return {
      published: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if a package version is published to NuGet registry
 */
export async function isNugetPublished(
  packageId: string,
  version: string,
  registry: NugetRegistry
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
  registry: DockerRegistry
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
  registry: NpmRegistry | NugetRegistry | DockerRegistry
): Promise<VerificationResult> {
  switch (registry.type) {
    case 'npm':
      return isNpmPublished(artifactName, version, registry);

    case 'nuget':
      return isNugetPublished(artifactName, version, registry);

    case 'docker':
      return isDockerPublished(artifactName, version, registry);

    default:
      throw new Error(`Unknown registry type: ${(registry as unknown as { type: string }).type}`);
  }
}
