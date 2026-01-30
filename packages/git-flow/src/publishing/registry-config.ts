import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { RegistryConfig, Registry } from './types.js';

/**
 * Load registry configuration from .github/registries.yml
 */
export async function loadRegistryConfig(workspaceRoot: string): Promise<RegistryConfig> {
  const configPath = join(workspaceRoot, '.github', 'registries.yml');
  
  try {
    const content = await readFile(configPath, 'utf-8');
    const config = parseYaml(content) as RegistryConfig;
    
    validateRegistryConfig(config);
    
    return config;
  } catch (error) {
    throw new Error(
      `Failed to load registry configuration from ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Validate registry configuration structure
 */
export function validateRegistryConfig(config: RegistryConfig): void {
  if (!config.registries || typeof config.registries !== 'object') {
    throw new Error('Registry config must have "registries" object');
  }

  for (const [name, registry] of Object.entries(config.registries)) {
    if (!registry.type) {
      throw new Error(`Registry "${name}" missing required field: type`);
    }

    if (!registry.url) {
      throw new Error(`Registry "${name}" missing required field: url`);
    }

    if (!registry.auth) {
      throw new Error(`Registry "${name}" missing required field: auth`);
    }

    // Type-specific validation
    switch (registry.type) {
      case 'npm':
        // NPM registries are valid with just base fields
        break;

      case 'nuget':
        // NuGet registries are valid with just base fields
        break;

      case 'docker':
        if (!('registry' in registry) || !registry.registry) {
          throw new Error(`Docker registry "${name}" missing required field: registry`);
        }
        break;

      default:
        throw new Error(`Registry "${name}" has invalid type: ${(registry as any).type}`);
    }
  }
}

/**
 * Get registry by name from configuration
 */
export function getRegistry(config: RegistryConfig, name: string): Registry {
  const registry = config.registries[name];
  
  if (!registry) {
    throw new Error(
      `Registry "${name}" not found in configuration. ` +
      `Available registries: ${Object.keys(config.registries).join(', ')}`
    );
  }

  return registry;
}

/**
 * Get authentication token for a registry from environment variables
 */
export function getToken(registry: Registry): string {
  const token = process.env[registry.auth];
  
  if (!token) {
    throw new Error(
      `Authentication token not found for registry. ` +
      `Expected environment variable: ${registry.auth}`
    );
  }

  return token;
}
