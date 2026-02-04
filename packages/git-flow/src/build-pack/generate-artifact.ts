/**
 * Artifact descriptor generation
 * 
 * Generates artifact descriptors after packing, supporting multiple config formats.
 */

import type { ProjectArtifactDescriptor } from '@cpdevtools/ts-dev-utilities/artifacts';
import { writeArtifact } from '@cpdevtools/ts-dev-utilities/artifacts';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Artifact configuration that can be provided in release-artifacts.* files
 */
export interface ArtifactConfig {
  artifacts: Array<{
    type: string;
    name: string;
    path: string;
    registries: string[];
  }>;
}

/**
 * Hard-coded temporary directory for artifact generation
 */
export const ARTIFACT_OUTPUT_DIR = join(tmpdir(), 'git-flow-artifacts');

/**
 * Replace environment variable placeholders in a string
 * Supports ${VAR_NAME} syntax
 */
function replaceEnvVars(str: string, envVars: Record<string, string>): string {
  return str.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    return envVars[varName] ?? match;
  });
}

/**
 * Replace environment variables in artifact config
 */
function substituteEnvVars(config: ArtifactConfig, envVars: Record<string, string>): ArtifactConfig {
  return {
    ...config,
    artifacts: config.artifacts.map(artifact => ({
      ...artifact,
      path: replaceEnvVars(artifact.path, envVars),
      name: replaceEnvVars(artifact.name, envVars),
    }))
  };
}

/**
 * Load artifact configuration from release-artifacts.* file in package root
 * Supports: .yml, .yaml, .json, .ts, .js, .cjs
 * YAML/JSON files support environment variable substitution with ${VAR_NAME} syntax
 */
async function loadArtifactConfig(
  packageDir: string,
  envVars: Record<string, string>
): Promise<ArtifactConfig | null> {
  const configFiles = [
    'release-artifacts.yml',
    'release-artifacts.yaml',
    'release-artifacts.json',
    'release-artifacts.ts',
    'release-artifacts.js',
    'release-artifacts.cjs'
  ];

  for (const configFile of configFiles) {
    const configPath = join(packageDir, configFile);
    if (!existsSync(configPath)) {
      continue;
    }

    console.log(`  📄 Found config: ${configFile}`);
    
    if (configFile.endsWith('.yml') || configFile.endsWith('.yaml')) {
      const content = await readFile(configPath, 'utf-8');
      const config = parseYaml(content) as ArtifactConfig;
      return substituteEnvVars(config, envVars);
    } else if (configFile.endsWith('.json')) {
      const content = await readFile(configPath, 'utf-8');
      const config = JSON.parse(content) as ArtifactConfig;
      return substituteEnvVars(config, envVars);
    } else {
      // For .ts, .js, .cjs - dynamically import them (no substitution needed, they have access to process.env)
      // Use file:// protocol for proper ESM import
      const fileUrl = `file://${configPath}`;
      const config = await import(fileUrl);
      return (config.default || config) as ArtifactConfig;
    }
  }

  return null;
}

/**
 * Generate artifact descriptor after packing
 * 
 * @param packageDir - Directory containing package.json
 * @param packageName - Name from package.json
 * @param packageVersion - Version from package.json
 * @returns Path to generated artifact.yml file
 */
export async function generateArtifactDescriptor(
  packageDir: string,
  packageName: string,
  packageVersion: string
): Promise<string> {
  const tarballName = `${packageName.replace('@', '').replace('/', '-')}-${packageVersion}.tgz`;
  const artifactFilename = packageName.replace(/@/g, '').replace(/\//g, '-');
  
  console.log(`  📦 Generating artifact descriptor for ${packageName}@${packageVersion}`);
  console.log(`  📁 Artifact directory: ${ARTIFACT_OUTPUT_DIR}`);
  
  // Ensure artifact directory exists
  await mkdir(ARTIFACT_OUTPUT_DIR, { recursive: true });
  
  // Copy tarball to artifact directory
  const tarballSource = join(packageDir, tarballName);
  const tarballDest = join(ARTIFACT_OUTPUT_DIR, tarballName);
  
  if (!existsSync(tarballSource)) {
    throw new Error(`Tarball not found: ${tarballSource}`);
  }
  
  await copyFile(tarballSource, tarballDest);
  console.log(`  ✓ Copied tarball to artifacts directory`);
  
  // Set environment variables for writeArtifact and config substitution
  const envVars = {
    PROJECT_NAME: artifactFilename,
    ARTIFACT_OUTPUT_DIR,
    TARBALL_NAME: tarballName,
    TARBALL_PATH: tarballDest,
    PACKAGE_NAME: packageName,
    PACKAGE_VERSION: packageVersion,
  };
  
  process.env.PROJECT_NAME = artifactFilename;
  process.env.ARTIFACT_OUTPUT_DIR = ARTIFACT_OUTPUT_DIR;
  
  // Load artifact config - required
  const config = await loadArtifactConfig(packageDir, envVars);
  
  if (!config) {
    throw new Error(
      `No release-artifacts configuration found in ${packageDir}\n` +
      `Please create one of: release-artifacts.yml, release-artifacts.json, release-artifacts.ts, release-artifacts.js, release-artifacts.cjs\n` +
      `See release-artifacts.example.yml for format`
    );
  }
  
  console.log(`  ✓ Using artifact configuration from package root`);
  
  const descriptor: ProjectArtifactDescriptor = {
    project: packageName,
    artifacts: config.artifacts
  };
  
  // Generate artifact descriptor
  await writeArtifact(descriptor);
  
  const artifactPath = join(ARTIFACT_OUTPUT_DIR, `${artifactFilename}.artifact.yml`);
  console.log(`  ✓ Artifact descriptor generated: ${artifactPath}`);
  
  return artifactPath;
}
