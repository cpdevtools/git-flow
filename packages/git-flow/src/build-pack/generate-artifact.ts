/**
 * Artifact descriptor generation
 *
 * Generates artifact descriptors after packing, supporting multiple config formats.
 * Dispatches per-type work through the artifact type handler registry.
 */

import type { Artifact, ProjectArtifactDescriptor } from "@cpdevtools/ts-dev-utilities/artifacts";
import { writeArtifact } from "@cpdevtools/ts-dev-utilities/artifacts";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getArtifactType, safeName, type PackContext } from "../artifacts/index.js";

/**
 * Artifact configuration that can be provided in release-artifacts.* files
 */
export interface ArtifactConfig {
  artifacts: Artifact[];
}

/**
 * Hard-coded temporary directory for artifact generation
 */
export const ARTIFACT_OUTPUT_DIR = join(tmpdir(), "git-flow-artifacts");

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
function substituteEnvVars(
  config: ArtifactConfig,
  envVars: Record<string, string>,
): ArtifactConfig {
  return {
    ...config,
    artifacts: config.artifacts.map((artifact) => {
      const base = {
        ...artifact,
        name: replaceEnvVars(artifact.name, envVars),
      };

      if ("path" in artifact && artifact.path) {
        return {
          ...base,
          path: replaceEnvVars(artifact.path, envVars),
        } as Artifact;
      }

      return base as Artifact;
    }),
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
    "release-artifacts.yml",
    "release-artifacts.yaml",
    "release-artifacts.json",
    "release-artifacts.ts",
    "release-artifacts.js",
    "release-artifacts.cjs",
  ];

  for (const configFile of configFiles) {
    const configPath = join(packageDir, configFile);
    if (!existsSync(configPath)) {
      continue;
    }

    console.log(`  📄 Found config: ${configFile}`);

    if (configFile.endsWith(".yml") || configFile.endsWith(".yaml")) {
      const content = await readFile(configPath, "utf-8");
      const config = parseYaml(content) as ArtifactConfig;
      return substituteEnvVars(config, envVars);
    } else if (configFile.endsWith(".json")) {
      const content = await readFile(configPath, "utf-8");
      const config = JSON.parse(content) as ArtifactConfig;
      return substituteEnvVars(config, envVars);
    } else {
      const fileUrl = `file://${configPath}`;
      const mod = await import(fileUrl);
      return (mod.default || mod) as ArtifactConfig;
    }
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

  for (const artifact of config.artifacts) {
    await getArtifactType(artifact.type).pack(artifact, ctx);
  }

  const descriptor: ProjectArtifactDescriptor = {
    project: packageName,
    artifacts: config.artifacts,
  };

  await writeArtifact(descriptor);

  const artifactPath = join(ARTIFACT_OUTPUT_DIR, `${artifactFilename}.artifact.yml`);
  console.log(`  ✓ Artifact descriptor generated: ${artifactPath}`);

  return artifactPath;
}
