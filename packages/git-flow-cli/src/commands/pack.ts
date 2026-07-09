/**
 * gitflow pack command
 *
 * Called by a project's github.actions.pack script after the project-specific
 * packing is done (e.g. `pnpm pack`, `docker save`, etc.).
 *
 * Reads release-artifacts.yml, dispatches each artifact to its type handler's
 * pack() method, then writes the .artifact.yml descriptor to ARTIFACT_OUTPUT_DIR.
 *
 * Required env vars:
 *   PROJECT_NAME        — package name
 *   PROJECT_VERSION     — semver string
 *   ARTIFACT_OUTPUT_DIR — output directory (defaults to /tmp/git-flow-artifacts)
 */

import { Command, Flags } from '@oclif/core';
import { join } from 'node:path';
import {
  getArtifactType,
  safeName,
  writeArtifact,
  type PackContext,
  type ProjectArtifactDescriptor,
} from '@cpdevtools/git-flow/artifacts';
import { loadArtifactConfig, ARTIFACT_OUTPUT_DIR } from '@cpdevtools/git-flow/build-pack';

export default class Pack extends Command {
  static override description =
    'Read release-artifacts.yml, run per-type pack handlers, and write the .artifact.yml descriptor';

  static override examples = [
    'PROJECT_NAME=@org/pkg PROJECT_VERSION=1.0.0 <%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --project-name @org/pkg --version 1.0.0',
  ];

  static override flags = {
    'output-dir': Flags.string({
      char: 'o',
      description: 'Artifact output directory (overrides ARTIFACT_OUTPUT_DIR)',
    }),
    'project-name': Flags.string({
      char: 'n',
      description: 'Project name (overrides PROJECT_NAME env var)',
    }),
    version: Flags.string({
      char: 'v',
      description: 'Project version (overrides PROJECT_VERSION env var)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Pack);

    const projectName = flags['project-name'] ?? process.env.PROJECT_NAME;
    const version = flags.version ?? process.env.PROJECT_VERSION;
    const cwd = process.cwd();
    const outputDir = flags['output-dir'] ?? process.env.ARTIFACT_OUTPUT_DIR ?? ARTIFACT_OUTPUT_DIR;
    const artifactFilename = safeName(projectName ?? 'artifact');

    if (!projectName || !version) {
      this.error(
        'PROJECT_NAME and PROJECT_VERSION are required (via flags or environment variables)',
      );
    }

    const envVars: Record<string, string> = {
      PROJECT_NAME: artifactFilename,
      ARTIFACT_OUTPUT_DIR: outputDir,
      PACKAGE_NAME: projectName,
      PACKAGE_VERSION: version,
    };

    // writeArtifact reads ARTIFACT_OUTPUT_DIR and PROJECT_NAME from process.env
    process.env.ARTIFACT_OUTPUT_DIR = outputDir;
    process.env.PROJECT_NAME = artifactFilename;

    const config = await loadArtifactConfig(cwd, envVars);
    if (!config) {
      this.error(
        `No release-artifacts configuration found in ${cwd}\n` +
          `Please create release-artifacts.yml (or .json/.ts/.js/.cjs).`,
      );
    }

    const ctx: PackContext = {
      projectCwd: cwd,
      artifactOutputDir: outputDir,
      projectName,
      version,
    };

    for (const artifact of config.artifacts ?? []) {
      await getArtifactType(artifact.type).pack(artifact, ctx);
    }

    const descriptor: ProjectArtifactDescriptor = {
      project: projectName,
      artifacts: config.artifacts ?? [],
    };

    await writeArtifact(descriptor);

    const descriptorPath = join(outputDir, `${artifactFilename}.artifact.yml`);
    this.log(`✓ Artifact descriptor written: ${descriptorPath}`);
  }
}
