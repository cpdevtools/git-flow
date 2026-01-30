/**
 * Configuration types for CLI tools and project overrides
 */

export interface PackContext {
  /** Project name (e.g., @cpdevtools/package) */
  projectName: string;
  /** Project version */
  version: string;
  /** Project root directory */
  cwd: string;
  /** Output directory for artifacts */
  outputDir: string;
  /** Sanitized filename for artifacts (@ and / removed) */
  artifactFilename: string;
  /** Git commit SHA */
  sha: string;
}

export interface BuildContext {
  /** Project name */
  projectName: string;
  /** Project version */
  version: string;
  /** Project root directory */
  cwd: string;
  /** Git commit SHA */
  sha: string;
}

export interface ApplyVersionContext {
  /** Project name */
  projectName: string;
  /** Version to apply */
  version: string;
  /** Project root directory */
  cwd: string;
}

export interface PackHooks {
  /** Called before default pack logic */
  beforePack?: (context: PackContext) => Promise<void> | void;
  /** Called after default pack logic */
  afterPack?: (context: PackContext) => Promise<void> | void;
  /** Complete override of pack logic (bypasses default) */
  execute?: (context: PackContext) => Promise<void> | void;
}

export interface BuildHooks {
  /** Called before default build logic */
  beforeBuild?: (context: BuildContext) => Promise<void> | void;
  /** Called after default build logic */
  afterBuild?: (context: BuildContext) => Promise<void> | void;
}

export interface ApplyVersionHooks {
  /** Called before default version application */
  beforeApplyVersion?: (context: ApplyVersionContext) => Promise<void> | void;
  /** Called after default version application */
  afterApplyVersion?: (context: ApplyVersionContext) => Promise<void> | void;
  /** Complete override of version application (bypasses default) */
  execute?: (context: ApplyVersionContext) => Promise<void> | void;
}

/**
 * Configuration file structure (cpdevtools.config.ts)
 */
export interface CPDevToolsConfig {
  pack?: PackHooks;
  build?: BuildHooks;
  applyVersion?: ApplyVersionHooks;
}

export interface ArtifactDescriptor {
  project: string;
  artifacts: Array<{
    type: 'npm' | 'nuget' | 'release-attachment';
    name: string;
    path: string;
    registries?: string[];
  }>;
}
