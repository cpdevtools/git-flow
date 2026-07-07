# Phase 2: Build & Pack Workflow

Complete guide for implementing the Build & Pack workflow in your monorepo.

## Table of Contents

1. [Overview](#overview)
2. [Workflow Steps](#workflow-steps)
3. [Project Configuration](#project-configuration)
4. [Artifact Types](#artifact-types)
5. [GitHub Action Setup](#github-action-setup)
6. [Package Script Examples](#package-script-examples)
7. [Troubleshooting](#troubleshooting)

## Overview

The Build & Pack workflow (Phase 2) automates building and packaging projects from a release PR. It:

- ✅ Reads release metadata from PR description
- ✅ Discovers all workspace projects and dependencies
- ✅ Builds all required projects (smart dependency resolution)
- ✅ Packs only projects marked for release
- ✅ Creates draft GitHub releases with artifacts
- ✅ Supports resumability (skip completed projects)
- ✅ Handles multiple artifact types (npm, docker, nuget, attachments)

## Workflow Steps

### 1. PR Metadata Parsing

The workflow reads a YAML code block from the PR description:

```yaml
runNumber: 42
sha: abc1234567890
timestamp: '2026-01-29T12:00:00Z'
sourceBranch: develop
projects:
  - name: my-package
    version: 1.2.3
    prerelease: false
    cwd: packages/my-package
```

### 2. Project Discovery

- Scans workspace for all projects
- Builds dependency graph
- Identifies projects to release (from PR metadata)
- Finds all dependencies that need building

### 3. Resumability Check

Checks existing draft releases for each project:
- Tag format: `{project-name}/v{version}`
- Looks for `{project-name}.artifact.yml` asset
- Skips projects that are already complete

### 4. Build Phase

Executes `pnpm run github.actions.build` for:
- All projects marked for release
- All their workspace dependencies

Environment variables provided:
- `PROJECT_NAME` - Current project name
- `PROJECT_VERSION` - Version to build
- `ARTIFACT_OUTPUT_DIR` - Output directory (e.g., `.artifacts`)
- `GITHUB_SHA` - Git commit SHA

### 5. Pack Phase

Executes `pnpm run github.actions.pack` for:
- Only projects marked for release
- Must generate `${ARTIFACT_OUTPUT_DIR}/${PROJECT_NAME}.artifact.yml`

### 6. Upload Phase

For each project:
1. Creates/finds draft release (`{project-name}/v{version}`)
2. Uploads `{project-name}.artifact.yml`
3. Uploads artifact files based on type:
   - NPM: `.tgz` file
   - Docker: `.image.tar.gz` (gzipped `docker save` tarball)
   - NuGet: `.nupkg` file
   - Attachment: Specified file

## Project Configuration

Each project must implement two package scripts:

### Required: `github.actions.build`

Builds your project. Typically just runs your normal build process.

**Example (TypeScript package):**
```json
{
  "scripts": {
    "build": "tsc",
    "github.actions.build": "npm run build"
  }
}
```

**Example (Next.js app):**
```json
{
  "scripts": {
    "build": "next build",
    "github.actions.build": "npm run build"
  }
}
```

### Required: `github.actions.pack`

Packages your project and creates the artifact descriptor.

**Environment variables available:**
- `PROJECT_NAME` - Your project name
- `PROJECT_VERSION` - Version being released
- `ARTIFACT_OUTPUT_DIR` - Where to put artifacts (e.g., `.artifacts`)

**Must create:** `${ARTIFACT_OUTPUT_DIR}/${PROJECT_NAME}.artifact.yml`

## Artifact Types

### NPM Package

**Pack script:**
```json
{
  "scripts": {
    "github.actions.pack": "npm pack --pack-destination=$ARTIFACT_OUTPUT_DIR && node scripts/create-npm-artifact.js"
  }
}
```

**Helper script** (`scripts/create-npm-artifact.js`):
```javascript
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const projectName = process.env.PROJECT_NAME;
const version = process.env.PROJECT_VERSION;
const outputDir = process.env.ARTIFACT_OUTPUT_DIR;

// npm pack creates: @scope-package-1.2.3.tgz
const tarballName = `${projectName.replace('@', '').replace('/', '-')}-${version}.tgz`;

const descriptor = {
  project: projectName,
  artifacts: [{
    type: 'npm',
    name: projectName,
    path: tarballName,
    registries: ['npm', 'github']
  }]
};

writeFileSync(
  join(outputDir, `${projectName}.artifact.yml`),
  `project: ${projectName}\n` +
  `artifacts:\n` +
  `  - type: npm\n` +
  `    name: ${projectName}\n` +
  `    path: ${tarballName}\n` +
  `    registries: [npm, github]\n`
);
```

### Docker Image

Docker images use the built-in `gitflow pack` handler. Build the image first,
then declare it in `release-artifacts.yml`:

```json
{
  "scripts": {
    "github.actions.build": "docker build -t my-image:${PROJECT_VERSION:-dev} -t my-image:latest .",
    "github.actions.pack": "gitflow pack"
  }
}
```

```yaml
# release-artifacts.yml
artifacts:
  - type: docker
    name: ghcr.io/myorg/my-image   # fully-qualified: ghcr.io/<owner>/<image>
    localTag: my-image:latest       # local tag to save (defaults to <name>:latest)
    registries: [ghcr, dockerhub]
```

During `pack`, `gitflow` serializes the built image with `docker save | gzip`
into a tarball artifact (`<name>.image.tar.gz`) and records the image id as
`digest`. That tarball is uploaded to the draft release and travels to the
publish job, which runs `docker load`, verifies the `digest`, then tags and
pushes the final release/`latest` tags. No transient `temp-*` tag is ever pushed
to the registry, so nothing needs cleaning up afterwards.

The generated descriptor looks like:

```yaml
project: my-image
artifacts:
  - type: docker
    name: ghcr.io/myorg/my-image
    localTag: my-image:latest
    finalTag: 1.0.0
    digest: sha256:...
    registry: ghcr.io
    imageArchive: /tmp/git-flow-artifacts/myorg-my-image.image.tar.gz
    pushedAt: '2026-01-29T12:00:00Z'
    registries: [ghcr, dockerhub]
```

### NuGet Package

**Pack script:**
```json
{
  "scripts": {
    "github.actions.pack": "dotnet pack -c Release -o $ARTIFACT_OUTPUT_DIR && node scripts/create-nuget-artifact.js"
  }
}
```

**Helper script:**
```javascript
const descriptor = `project: ${projectName}
artifacts:
  - type: nuget
    name: MyOrg.${projectName}
    path: MyOrg.${projectName}.${version}.nupkg
    registries: [nuget, github]
`;
```

### Release Attachment

For arbitrary files (binaries, documentation, etc.):

```yaml
project: my-app
artifacts:
  - type: release-attachment
    name: my-app-linux-x64
    path: dist/my-app-linux-x64
    contentType: application/octet-stream
  - type: release-attachment
    name: documentation.pdf
    path: docs/output/documentation.pdf
    contentType: application/pdf
```

## GitHub Action Setup

### Workflow File

Create `.github/workflows/build-pack.yml`:

```yaml
name: Build & Pack

on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches:
      - 'release/**'

permissions:
  contents: write
  pull-requests: read
  packages: write # required to push docker artifacts to GHCR

jobs:
  build-pack:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      
      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: 'pnpm'
      
      - name: Install dependencies
        run: pnpm install
      
      - name: Build & Pack
        uses: cpdevtools/git-flow/actions/build-pack@main
        with:
          pr-number: ${{ github.event.pull_request.number }}
          token: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Upload artifact manifests
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: artifact-manifests
          path: .artifacts/*.yml
```

### Permissions

The workflow requires:
- `contents: write` - Create draft releases and upload assets
- `pull-requests: read` - Read PR description
- `packages: write` - Push docker artifacts to GHCR (required only when packing `docker` artifacts)

### Secrets

Uses `secrets.GITHUB_TOKEN` (automatically provided by GitHub Actions).

## Troubleshooting

### "Missing artifact.yml"

**Problem:** Pack step completes but artifact.yml not found.

**Solution:** Ensure your `github.actions.pack` script creates the file at:
```
${ARTIFACT_OUTPUT_DIR}/${PROJECT_NAME}.artifact.yml
```

**Debug:**
```bash
echo "Output dir: $ARTIFACT_OUTPUT_DIR"
echo "Project name: $PROJECT_NAME"
ls -la $ARTIFACT_OUTPUT_DIR/
```

### "GitHub API rate limit"

**Problem:** Too many API calls when checking resumability.

**Solution:** The workflow already implements caching. If you hit rate limits, ensure you're not running multiple workflows simultaneously on the same PR.

### "File not found during upload"

**Problem:** Upload fails because artifact file path is incorrect.

**Solution:** Paths in artifact.yml must be relative to the project's `cwd`:
```yaml
# Correct (relative to project root)
path: dist/package-1.0.0.tgz

# Wrong (absolute path)
path: /workspace/packages/my-pkg/dist/package-1.0.0.tgz
```

### "Build succeeds but pack fails"

**Problem:** Build works but pack script errors.

**Solution:** Check that all environment variables are used correctly:
```bash
# In your pack script, add debugging:
echo "PROJECT_NAME=$PROJECT_NAME"
echo "PROJECT_VERSION=$PROJECT_VERSION"
echo "ARTIFACT_OUTPUT_DIR=$ARTIFACT_OUTPUT_DIR"
```

### "Dependencies not built"

**Problem:** Project build fails because dependency is outdated.

**Solution:** The workflow automatically builds dependencies. Ensure:
1. Dependencies are declared in `package.json`
2. Dependencies are workspace packages (not external)
3. `pnpm-workspace.yaml` correctly lists all packages

## Example Complete Setup

**Project structure:**
```
my-monorepo/
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   └── scripts/
│   │       └── create-artifact.js
│   └── app/
│       ├── package.json
│       └── scripts/
│           └── create-artifact.js
├── .github/
│   └── workflows/
│       └── build-pack.yml
└── pnpm-workspace.yaml
```

**packages/core/package.json:**
```json
{
  "name": "@myorg/core",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "github.actions.build": "npm run build",
    "github.actions.pack": "npm pack --pack-destination=$ARTIFACT_OUTPUT_DIR && node scripts/create-artifact.js"
  }
}
```

**packages/core/scripts/create-artifact.js:**
```javascript
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const name = process.env.PROJECT_NAME;
const version = process.env.PROJECT_VERSION;
const dir = process.env.ARTIFACT_OUTPUT_DIR;
const tarball = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;

writeFileSync(
  join(dir, `${name}.artifact.yml`),
  `project: ${name}\nartifacts:\n  - type: npm\n    name: ${name}\n    path: ${tarball}\n    registries: [npm]\n`
);
```

## Next Steps

After Phase 2 completes:
- Draft releases created with artifacts
- Ready for Phase 3: Publish & Release
- Can manually verify artifacts before publishing
- Resumability allows re-running failed builds
