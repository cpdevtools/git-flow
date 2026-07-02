# CLI Tools Documentation

The git-flow ecosystem provides two CLI tools:

| CLI | Package | Purpose |
|-----|---------|----------|
| `gitflow` | `@cpdevtools/git-flow` | Build and pack operations (artifact creation, version application) |
| `devutil` | `@cpdevtools/ts-dev-utilities` | Workspace script runner and inspector |

---

## `gitflow` — Build & Pack CLI

Provides standardized build and pack operations across projects.

## Installation

Both CLIs are installed as part of their respective packages:

```bash
# gitflow
pnpm add -D @cpdevtools/git-flow

# devutil
pnpm add -D @cpdevtools/ts-dev-utilities
```

---

## CLI Commands — `gitflow`

### Overview

Instead of requiring every project to write custom scripts, the CLI provides:
- **Default implementations** for common tasks (pack npm/nuget packages, apply versions)
- **Hook system** for customization without rewriting logic
- **Configuration override** via `cpdevtools.config.ts`
- **Modern CLI** with autocomplete support and modular architecture

### gitflow pack

Automatically detects project type and creates distribution artifacts with descriptors.

**Supported project types:**
- **NPM**: Runs `pnpm pack`, generates artifact.yml
- **NuGet**: Runs `dotnet pack`, generates artifact.yml

**Usage in package.json:**
```json
{
  "scripts": {
    "github.actions.pack": "gitflow pack"
  }
}
```

**Direct usage:**
```bash
# Using environment variables
PROJECT_NAME=my-package PROJECT_VERSION=1.0.0 gitflow pack

# Using flags
gitflow pack --project-name my-package --version 1.0.0

# With custom output directory
gitflow pack --output-dir ./dist
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

### gitflow apply-version

Applies version to project files before building.

**Supported file types:**
- `package.json` (NPM projects)
- `*.csproj` (NuGet projects)

**Usage:**
```bash
# Using environment variable
PROJECT_VERSION=1.2.3 gitflow apply-version

# Using argument
gitflow apply-version 1.2.3

# Using flag
gitflow apply-version --version 1.2.3
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
    "github.actions.pack": "gitflow pack"
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

---

## CLI Commands — `devutil`

A lightweight workspace runner and inspector from `@cpdevtools/ts-dev-utilities`.
Runs scripts across all projects in dependency order — projects start as soon as
their workspace dependencies have passed, not in fixed waves.

### devutil run

Run one or more scripts across the workspace:

```bash
# Run github.actions.test across all projects
devutil run github.actions.test

# Run build then test per project (test-optional equivalent)
devutil run github.actions.build github.actions.test

# Stop on first failure, cancel in-flight tasks
devutil run github.actions.test --fail-fast

# Cap parallelism
devutil run github.actions.test --concurrency 4

# Treat a missing script as an error instead of a no-op
devutil run github.actions.test --missing-script error

# Use a specific workspace root
devutil run github.actions.test --cwd /path/to/workspace
```

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--fail-fast` | off | Stop on first failure, cancel in-flight tasks |
| `--concurrency <n>` | unlimited | Max tasks to run in parallel |
| `--cwd <path>` | `process.cwd()` | Workspace root |
| `--missing-script skip\|error` | `skip` | What to do when a project doesn't define the script |
| `--max-output <bytes>` | `1000000` | Max bytes of output to capture per task |

**Exit code:** 0 if all tasks passed or were no-script; 1 if any task failed.

### devutil discover

List all projects found in the workspace with their names, directories, and defined scripts:

```bash
devutil discover
devutil discover --cwd /path/to/workspace
```

### devutil graph

Print the workspace dependency graph:

```bash
devutil graph
devutil graph --cwd /path/to/workspace
```

### Standard CI script convention

Projects should define these scripts in `package.json` to participate in the
automated workflow:

| Script | Purpose | Provided by |
|--------|---------|-------------|
| `github.actions.build` | Compile, transpile, or otherwise prepare the project | Project author |
| `github.actions.test` | Run tests | Project author |
| `github.actions.pack` | Create distribution artifacts | `gitflow pack` |

Projects only need to define the scripts that apply. A project with no
`github.actions.test` is simply skipped (treated as a pass) by `devutil run`.

```json
{
  "scripts": {
    "github.actions.build": "pnpm run build",
    "github.actions.test": "pnpm run test",
    "github.actions.pack": "gitflow pack"
  }
}
```
