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
- ✅ Handles multiple artifact types (`npm`, `nuget`, `dotnet-lib`, `ng-lib`, `docker-image`, `docker-service`, `release-attachment`)

## Workflow Steps

### 1. PR Metadata Parsing

The workflow reads a YAML code block from the PR description:

```yaml
runNumber: 42
sha: abc1234567890
timestamp: '2026-01-29T12:00:00Z'
sourceBranch: develop
MAIN:
  projects:
    - name: my-package
      version: 1.2.3
      prerelease: false
      cwd: packages/my-package
```

Versions come from `.publish/versions.yml` (`0.0.0-MAIN: 1.2.3`), resolved per version key by
`create-release-pr` when it updates the PR.

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

Builds run through the workspace dependency graph in parallel, each project starting as soon as its
own dependencies have built. The release version is applied to the project's manifests first.

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
   - `npm`, `ng-lib`: `.tgz` file
   - `docker-image`: `.image.tar.gz` (gzipped `docker save` tarball)
   - `nuget`, `dotnet-lib`: `.nupkg` file
   - `release-attachment`: Specified file
   - `docker-service`: nothing — its product is the deploy bundle

## Project Configuration

A project takes part in a release when it defines `github.actions.pack`. Most projects also define
`github.actions.build`; a project with nothing to build (a `docker-service`) may omit it.

### `github.actions.build`

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

Packages your project and creates the artifact descriptor. The usual implementation is
`gitflow pack`, which reads the project's declarative `release-artifacts.yml` and dispatches each
entry to the handler for its `type`; the hand-written helper scripts below show what that produces.

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
  - type: docker-image
    name: my-image              # bare repository name — no host or namespace
    localTag: my-image:latest   # local tag to save (defaults to <project>:latest)
    registries: [ghcr, dockerhub]
    deploy: [swarm]             # optional: deploy methods to build bundles for
```

`name` must not contain a `/`. Host and namespace come from each registry entry in
`.publish/registries.yml` and are composed per destination, so the same image can publish to
several registries.

During `pack`, `gitflow` serializes the built image with `docker save | gzip`
into a tarball artifact (`<name>.image.tar.gz`), records the release version as
`finalTag` and the image id as `digest`. That tarball is uploaded to the draft
release and travels to the publish job, which runs `docker load`, verifies the
`digest`, then tags and pushes the release tag plus whichever floating tags
(`latest`, `next`, a channel) the version earns. Nothing is pushed to any
registry at pack time, so nothing needs cleaning up afterwards.

The generated descriptor looks like:

```yaml
project: my-image
artifacts:
  - type: docker-image
    name: my-image
    localTag: my-image:latest
    finalTag: 1.0.0
    digest: sha256:...
    imageArchive: /tmp/git-flow-artifacts/my-image.image.tar.gz
    pushedAt: '2026-01-29T12:00:00Z'
    registries: [ghcr, dockerhub]
    deploy: [swarm]
```

Any artifact may also carry deployment keys — `deploy` (methods: `compose`, `swarm`, `swarm-job`),
`versioning` (`singleton` or `major`), `stack`, `service`, `sharedStorage`, `seedStorage`. They
configure the deploy bundle, not the artifact.

### NuGet Package

`nuget` copies a `.nupkg` the build already produced and does not control its version. For a
library you own, prefer `dotnet-lib`, which builds and packs at the release version:

```yaml
artifacts:
  - type: dotnet-lib
    name: MyOrg.Package
    registries: [github-nuget]
```

**Pack script (`nuget`):**
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
    types: [closed]
    branches:
      - 'release/**'

permissions:
  contents: write
  pull-requests: read
  packages: read

jobs:
  build-pack:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.merge_commit_sha }}

      - name: Build & Pack
        uses: cpdevtools/git-flow/actions/build-pack@main
        with:
          pr-number: ${{ github.event.pull_request.number }}
          token: ${{ secrets.GITHUB_TOKEN }}
```

Check out the merge commit, not the branch head. The action installs Node, pnpm and the workspace
itself, so no setup steps are needed before it. `publish-release` runs afterwards in the same
workflow with `packages: write`.

### Permissions

The workflow requires:
- `contents: write` - Create draft releases and upload assets
- `pull-requests: read` - Read PR description
- `packages: read` - Install workspace packages from GitHub Packages. Nothing is pushed at pack time;
  registry pushes happen in `publish-release`

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
│       └── build-pack-publish.yml
├── .publish/
│   ├── versions.yml
│   └── registries.yml
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

After Build & Pack completes:
- Draft releases created with artifacts
- Ready for `publish-release`
- Can manually verify artifacts before publishing
- Resumability allows re-running failed builds
