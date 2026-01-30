# CLI Tools Documentation

The `@cpdevtools/git-flow` package provides a unified CLI tool (`cpdt-gitflow`) with subcommands for standardizing build and pack operations across projects.

## Overview

Instead of requiring every project to write custom scripts, the CLI provides:
- **Default implementations** for common tasks (pack npm/nuget packages, apply versions)
- **Hook system** for customization without rewriting logic  
- **Configuration override** via `cpdevtools.config.ts`
- **Modern CLI** with autocomplete support and modular architecture

## Installation

The CLI is automatically available when you install `@cpdevtools/git-flow`:

```bash
pnpm add -D @cpdevtools/git-flow
```

## CLI Commands

### cpdt-gitflow pack

Automatically detects project type and creates distribution artifacts with descriptors.

**Supported project types:**
- **NPM**: Runs `pnpm pack`, generates artifact.yml
- **NuGet**: Runs `dotnet pack`, generates artifact.yml

**Usage in package.json:**
```json
{
  "scripts": {
    "github.actions.pack": "cpdt-gitflow pack"
  }
}
```

**Direct usage:**
```bash
# Using environment variables
PROJECT_NAME=my-package PROJECT_VERSION=1.0.0 cpdt-gitflow pack

# Using flags
cpdt-gitflow pack --project-name my-package --version 1.0.0

# With custom output directory
cpdt-gitflow pack --output-dir ./dist
```

**Flags:**
- `-n, --project-name` - Project name (overrides PROJECT_NAME env var)
- `-v, --version` - Project version (overrides PROJECT_VERSION env var)
- `-o, --output-dir` - Output directory for artifacts (overrides ARTIFACT_OUTPUT_DIR)

**Environment variables (automatically provided by workflow):**
- `PROJECT_NAME` - Package name (e.g., @cpdevtools/package)
- `PROJECT_VERSION` - Version to pack
- `ARTIFACT_OUTPUT_DIR` - Where to place artifacts
- `ARTIFACT_FILENAME` - Sanitized filename (@ and / removed)
- `GITHUB_SHA` - Git commit SHA

### cpdt-gitflow apply-version

Applies version to project files before building.

**Supported file types:**
- `package.json` (NPM projects)
- `*.csproj` (NuGet projects)

**Usage:**
```bash
# Using environment variable
PROJECT_VERSION=1.2.3 cpdt-gitflow apply-version

# Using argument
cpdt-gitflow apply-version 1.2.3

# Using flag
cpdt-gitflow apply-version --version 1.2.3
```

**Flags:**
- `-v, --version` - Version to apply (overrides PROJECT_VERSION env var)
- `-n, --project-name` - Project name (overrides PROJECT_NAME env var)

**Integration (automatic via build workflow):**
```json
{
  "scripts": {
    "github.actions.build": "npm run build"
  }
}
```

*Note: apply-version is automatically called before build - no manual invocation needed.*

**Environment variables:**
- `PROJECT_VERSION` - Version to apply
- `PROJECT_NAME` - Project name

## Configuration Override

Create `cpdevtools.config.ts` in your project root to customize behavior:

```typescript
import type { PackContext, ApplyVersionContext } from '@cpdevtools/git-flow/cli';

export const pack = {
  // Called before default pack logic
  beforePack: async (context: PackContext) => {
    console.log(`Custom pre-pack for ${context.projectName}`);
    // Run custom validation, file preparation, etc.
  },
  
  // Called after default pack logic  
  afterPack: async (context: PackContext) => {
    console.log(`Custom post-pack for ${context.projectName}`);
    // Add extra files to artifacts, sign packages, etc.
  },
  
  // Complete override - bypasses default logic
  execute: async (context: PackContext) => {
    // Full custom pack implementation
    // You're responsible for creating artifact.yml
  }
};

export const applyVersion = {
  beforeApplyVersion: async (context: ApplyVersionContext) => {
    // Custom pre-version logic
  },
  
  afterApplyVersion: async (context: ApplyVersionContext) => {
    // Custom post-version logic (e.g., update README)
  },
  
  execute: async (context: ApplyVersionContext) => {
    // Complete custom version application
  }
};
```

## Context Types

### PackContext

```typescript
interface PackContext {
  projectName: string;        // e.g., "@cpdevtools/package"
  version: string;            // e.g., "1.2.3"
  cwd: string;                // Project directory
  outputDir: string;          // Artifact output directory
  artifactFilename: string;   // Sanitized name (cpdevtools-package)
  sha: string;                // Git commit SHA
}
```

### ApplyVersionContext

```typescript
interface ApplyVersionContext {
  projectName: string;
  version: string;
  cwd: string;
}
```

## Artifact Descriptor Format

The pack tool generates `{project-name}.artifact.yml`:

```yaml
project: "@cpdevtools/package"
artifacts:
  - type: npm
    name: "@cpdevtools/package"
    path: cpdevtools-package-1.2.3.tgz
    registries:
      - npm
      - github
```

**Artifact types:**
- `npm` - NPM package tarball
- `nuget` - NuGet package (.nupkg)
- `release-attachment` - Generic file attachment

## Examples

### Basic NPM Project

```json
{
  "name": "@company/my-package",
  "scripts": {
    "build": "tsc",
    "github.actions.build": "npm run build",
    "github.actions.pack": "cpdevtools-pack"
  }
}
```

### Custom Pack with Extra Files

**cpdevtools.config.ts:**
```typescript
import { writeFile } from 'fs/promises';
import { join } from 'path';

export const pack = {
  afterPack: async (context) => {
    // Add README to artifacts
    const readmePath = join(context.outputDir, 'README.md');
    await writeFile(readmePath, '# Release Notes\n...');
    
    // Modify artifact descriptor to include it
    // (read artifact.yml, add entry, write back)
  }
};
```

### Multi-Registry Pack

**cpdevtools.config.ts:**
```typescript
export const pack = {
  afterPack: async (context) => {
    // Pack was done, now publish to multiple registries
    await $`npm publish --registry=https://registry.npmjs.org`;
    await $`npm publish --registry=https://npm.pkg.github.com`;
  }
};
```

## Benefits

✅ **No script duplication** - Projects don't need custom pack.js files
✅ **Standardized artifacts** - Consistent YAML descriptors across all projects
✅ **Easy customization** - Hook system for special cases
✅ **Type-safe overrides** - Full TypeScript support for config
✅ **Automatic version management** - Versions applied before build
✅ **Multi-project support** - Works with monorepos
