# Build & Pack Action

Phase 2 GitHub Action that builds and packages projects from a release PR, creating draft releases with artifacts.

## Overview

This action:
1. Reads PR metadata from a release PR description
2. Discovers workspace projects and dependencies
3. Builds all required projects (release projects + dependencies)
4. Packs only the release projects (generates artifact.yml descriptors)
5. Uploads artifacts to draft GitHub releases
6. Supports resumability - skips already-completed projects

## Usage

```yaml
name: Build & Pack

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  build-pack:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: read
    
    steps:
      - uses: actions/checkout@v4
      
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
      
      - run: pnpm install
      
      - uses: cpdevtools/git-flow/actions/build-pack@main
        with:
          pr-number: ${{ github.event.pull_request.number }}
          token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `pr-number` | Yes | - | Pull request number containing release metadata |
| `token` | No | `${{ github.token }}` | GitHub token with release permissions |
| `workspace-root` | No | `${{ github.workspace }}` | Workspace root directory |
| `artifact-output-dir` | No | `.artifacts` | Directory for artifact output files |

## Outputs

| Output | Description |
|--------|-------------|
| `projects-built` | Number of projects successfully built |
| `projects-packed` | Number of projects successfully packed |
| `projects-uploaded` | Number of projects successfully uploaded |
| `projects-skipped` | Number of projects skipped (already completed) |

## Project Requirements

Each project to be released must implement two package scripts:

### 1. `github.actions.build`

Builds the project. Environment variables available:
- `PROJECT_NAME` - Project name
- `PROJECT_VERSION` - Version to build
- `ARTIFACT_OUTPUT_DIR` - Where to output artifacts
- `GITHUB_SHA` - Git commit SHA

Example:
```json
{
  "scripts": {
    "github.actions.build": "npm run build"
  }
}
```

### 2. `github.actions.pack`

Packages the project and generates `artifact.yml`. Must create:
- `${ARTIFACT_OUTPUT_DIR}/${PROJECT_NAME}.artifact.yml` - Artifact descriptor

Example for NPM package:
```json
{
  "scripts": {
    "github.actions.pack": "npm pack --pack-destination=$ARTIFACT_OUTPUT_DIR && node scripts/create-artifact-yml.js"
  }
}
```

Example `artifact.yml`:
```yaml
project: my-package
artifacts:
  - type: npm
    name: '@myorg/my-package'
    path: dist/my-package-1.0.0.tgz
    registries: [npm, github]
```

## Artifact Types

Supported artifact types:

### NPM Package
```yaml
- type: npm
  name: '@myorg/package'
  path: dist/package-1.0.0.tgz
  registries: [npm, github]
```

### Docker Image
```yaml
- type: docker
  name: ghcr.io/owner/image
  tempTag: temp-abc1234
  finalTag: 1.0.0
  digest: sha256:...
  registry: ghcr.io
  pushedAt: '2026-01-29T12:00:00Z'
  registries: [ghcr, dockerhub]
```

### NuGet Package
```yaml
- type: nuget
  name: MyOrg.Package
  path: dist/MyOrg.Package.1.0.0.nupkg
  registries: [nuget, github]
```

### Release Attachment
```yaml
- type: release-attachment
  name: documentation.pdf
  path: docs/output/documentation.pdf
  contentType: application/pdf
```

## Resumability

The action checks existing draft releases before processing. If a project's `{project}.artifact.yml` is already uploaded to its draft release, that project is skipped. This allows re-running the workflow without rebuilding completed projects.

## Smart Dependencies

The action automatically discovers and builds all workspace dependencies, but only packs and uploads projects explicitly listed in the PR metadata. This ensures dependencies are fresh without creating unnecessary releases.

## License

MIT
