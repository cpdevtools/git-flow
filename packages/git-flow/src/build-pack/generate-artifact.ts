/**
 * Artifact descriptor generation
 *
 * Generates artifact descriptors after packing, supporting multiple config formats.
 * Dispatches per-type work through the artifact type handler registry.
 */

import type { Artifact, ProjectArtifactDescriptor } from '@cpdevtools/ts-dev-utilities/artifacts';
import { writeArtifact } from '@cpdevtools/ts-dev-utilities/artifacts';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  getArtifactType,
  registerArtifactType,
  safeName,
  type PackContext,
} from '../artifacts/index.js';

/**
 * A plugin entry in release-artifacts.yml.
 * The package is dynamically imported (it must be installed in the workspace);
 * its top-level code calls registerArtifactType to add or override type handlers.
 */
export interface PluginConfig {
  /** npm package name to import, e.g. '@myorg/gitflow-helm' */
  package: string;
  /** Artifact declarations that use this plugin's types */
  artifacts?: Artifact[];
}

/**
 * Artifact configuration that can be provided in release-artifacts.* files
 */
export interface ArtifactConfig {
  /**
   * Plugin packages to load before dispatching artifacts.
   * Plugins are imported in list order; later registrations override earlier ones.
   * Built-in types (npm, nuget, docker, release-attachment, deploy) are always
   * registered first and can be overridden by any plugin.
   */
  plugins?: PluginConfig[];
  /** Artifact declarations using built-in or previously-loaded plugin types */
  artifacts?: Artifact[];
}

/**
 * Hard-coded temporary directory for artifact generation
 */
export const ARTIFACT_OUTPUT_DIR = join(tmpdir(), 'git-flow-artifacts');

/**
 * Replace environment variable placeholders in a string.
 * Supports ${VAR_NAME} syntax.
 */
function replaceEnvVars(str: string, envVars: Record<string, string>): string {
  return str.replace(/\${([^}]+)}/g, (match, varName) => {
    return envVars[varName] ?? match;
  });
}

/**
 * Replace environment variables in artifact config
 */
function substituteArtifact(artifact: Artifact, envVars: Record<string, string>): Artifact {
  const base = { ...artifact, name: replaceEnvVars(artifact.name, envVars) };
  if ('path' in artifact && artifact.path) {
    return { ...base, path: replaceEnvVars(artifact.path as string, envVars) } as Artifact;
  }
  return base as Artifact;
}

function substituteEnvVars(
  config: ArtifactConfig,
  envVars: Record<string, string>,
): ArtifactConfig {
  return {
    ...config,
    plugins: config.plugins?.map((p) => ({
      ...p,
      artifacts: p.artifacts?.map((a) => substituteArtifact(a, envVars)),
    })),
    artifacts: config.artifacts?.map((a) => substituteArtifact(a, envVars)),
  };
}

/**
 * Load artifact configuration from release-artifacts.* file in package root.
 */
export async function loadArtifactConfig(
  packageDir: string,
  envVars: Record<string, string>,
): Promise<ArtifactConfig | null> {
  const configFiles = [
    'release-artifacts.yml',
    'release-artifacts.yaml',
    'release-artifacts.json',
    'release-artifacts.ts',
    'release-artifacts.js',
    'release-artifacts.cjs',
  ];

  for (const configFile of configFiles) {
    const configPath = join(packageDir, configFile);
    if (!existsSync(configPath)) {
      continue;
    }

    console.log(`  📄 Found config: ${configFile}`);

    let raw: ArtifactConfig;
    if (configFile.endsWith('.yml') || configFile.endsWith('.yaml')) {
      const content = await readFile(configPath, 'utf-8');
      raw = parseYaml(content) as ArtifactConfig;
    } else if (configFile.endsWith('.json')) {
      const content = await readFile(configPath, 'utf-8');
      raw = JSON.parse(content) as ArtifactConfig;
    } else {
      const fileUrl = `file://${configPath}`;
      const mod = await import(fileUrl);
      raw = (mod.default || mod) as ArtifactConfig;
    }

    // Apply env-var substitution before loading plugins so ${VAR} in
    // package names is also resolved (e.g. ${PLUGIN_SCOPE}/my-plugin)
    const config = substituteEnvVars(raw, envVars);

    // Load plugins in order — each plugin calls registerArtifactType on import.
    // Later registrations override earlier ones (last wins).
    for (const plugin of config.plugins ?? []) {
      try {
        await import(plugin.package);
        console.log(`  🔌 Loaded plugin: ${plugin.package}`);
      } catch (err) {
        throw new Error(
          `Failed to load artifact plugin '${plugin.package}': ${err instanceof Error ? err.message : String(err)}\n` +
            `Ensure the package is installed in the workspace devDependencies.`,
        );
      }
    }

    // Flatten: plugin artifacts first (in list order), then root artifacts
    const allArtifacts: Artifact[] = [
      ...(config.plugins ?? []).flatMap((p) => p.artifacts ?? []),
      ...(config.artifacts ?? []),
    ];

    return { artifacts: allArtifacts };
  }

  return null;
}

/**
 * Generate artifact descriptor after packing.
 *
 * Reads release-artifacts.yml from packageDir, dispatches each artifact to its
 * type handler's pack() method, then writes the .artifact.yml descriptor.
 */
export async function generateArtifactDescriptor(
  packageDir: string,
  packageName: string,
  packageVersion: string,
): Promise<string> {
  const artifactFilename = safeName(packageName);

  console.log(`  📦 Generating artifact descriptor for ${packageName}@${packageVersion}`);
  console.log(`  📁 Artifact directory: ${ARTIFACT_OUTPUT_DIR}`);

  await mkdir(ARTIFACT_OUTPUT_DIR, { recursive: true });

  const envVars: Record<string, string> = {
    PROJECT_NAME: artifactFilename,
    ARTIFACT_OUTPUT_DIR,
    PACKAGE_NAME: packageName,
    PACKAGE_VERSION: packageVersion,
  };

  process.env.PROJECT_NAME = artifactFilename;
  process.env.ARTIFACT_OUTPUT_DIR = ARTIFACT_OUTPUT_DIR;

  const config = await loadArtifactConfig(packageDir, envVars);

  if (!config) {
    throw new Error(
      `No release-artifacts configuration found in ${packageDir}
` +
        `Please create one of: release-artifacts.yml, release-artifacts.json, release-artifacts.ts, release-artifacts.js, release-artifacts.cjs`,
    );
  }

  console.log(`  ✓ Using artifact configuration from package root`);

  const ctx: PackContext = {
    projectCwd: packageDir,
    artifactOutputDir: ARTIFACT_OUTPUT_DIR,
    projectName: packageName,
    version: packageVersion,
  };

  for (const artifact of config.artifacts ?? []) {
    await getArtifactType(artifact.type).pack(artifact, ctx);
  }

  const descriptor: ProjectArtifactDescriptor = {
    project: packageName,
    artifacts: config.artifacts ?? [],
  };

  await writeArtifact(descriptor);

  const artifactPath = join(ARTIFACT_OUTPUT_DIR, `${artifactFilename}.artifact.yml`);
  console.log(`  ✓ Artifact descriptor generated: ${artifactPath}`);

  return artifactPath;
}
