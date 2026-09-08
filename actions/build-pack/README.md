# Build & Pack Action

GitHub composite action that builds and packages projects from a merged release PR, creating draft
releases with artifacts. `publish-release` runs afterwards in the same workflow.

## Overview

This action:

1. Reads release metadata from the release PR description
2. Discovers workspace projects and dependencies
3. Builds all required projects (release projects + their workspace dependencies) through the
   dependency graph
4. Packs only the release projects (`gitflow pack` produces the `<project>.artifact.yml` descriptor)
5. Uploads artifacts to draft GitHub releases
6. Supports resumability - skips already-completed projects

## Usage

```yaml
name: Build, Pack & Publish

on:
  pull_request:
    types: [closed]
    branches:
      - 'release/**'

jobs:
  build-pack:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: read
      packages: read

    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.merge_commit_sha }}

      - uses: cpdevtools/git-flow/actions/build-pack@main
        with:
          pr-number: ${{ github.event.pull_request.number }}
          token: ${{ secrets.GITHUB_TOKEN }}
```

Check out the merge commit, not the branch head. The action installs Node, pnpm and the workspace
itself, so no setup steps are needed before it.

## Inputs

| Input            | Required | Default                   | Description                                                      |
| ---------------- | -------- | ------------------------- | ---------------------------------------------------------------- |
| `pr-number`      | No       | `0`                       | The merged release pull request, whose body carries the metadata |
| `token`          | No       | `${{ github.token }}`     | Needs `contents: write`, `pull-requests: read`, `packages: read` |
| `workspace-root` | No       | `${{ github.workspace }}` | Workspace root directory                                         |

## Outputs

| Output              | Description                                    |
| ------------------- | ---------------------------------------------- |
| `projects-built`    | Number of projects successfully built          |
| `projects-packed`   | Number of projects successfully packed         |
| `projects-uploaded` | Number of projects successfully uploaded       |
| `projects-skipped`  | Number of projects skipped (already completed) |

## Project Requirements

A project takes part in a release when it defines a `github.actions.pack` script. Most projects
also define `github.actions.build`; a project with nothing to build (a `docker-service`, for
example) may omit it.

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

Packages the project and generates `${ARTIFACT_OUTPUT_DIR}/${PROJECT_NAME}.artifact.yml`. The
usual implementation is the built-in CLI, which reads the project's `release-artifacts.yml`:

```json
{
  "scripts": {
    "github.actions.pack": "gitflow pack"
  }
}
```

Example `release-artifacts.yml`:

```yaml
artifacts:
  - type: npm
    name: '${PACKAGE_NAME}'
    registries: [github-npm]
```

Registry IDs refer to entries in `.publish/registries.yml`.

## Artifact Types

Built-in artifact types are `npm`, `nuget`, `dotnet-lib`, `ng-lib`, `docker-image`,
`docker-service` and `release-attachment`. See the wiki's Artifacts page for every field; the
common ones are below.

### NPM Package

```yaml
- type: npm
  name: '${PACKAGE_NAME}'
  registries: [npm, github-npm]
```

Pack fills in `path` with the tarball it produced.

### Docker Image

```yaml
- type: docker-image
  name: my-image # bare repository name, no host or namespace
  localTag: my-image:latest # local tag to save (defaults to <project>:latest)
  registries: [ghcr, dockerhub]
  deploy: [swarm]
```

`name` must not contain a `/`. Host and namespace come from each registry entry and are composed
per destination, so one image can publish to several registries.

At pack time the built image is serialized with `docker save | gzip` into a tarball
(`<name>.image.tar.gz`) that is uploaded to the draft release and travels to the publish job. Pack
records the release version as `finalTag` and the image id as `digest`; the publish job runs
`docker load`, verifies the `digest`, then tags and pushes the release tag plus whichever floating
tags (`latest`, `next`, a channel) the version earns. Nothing is pushed to any registry at pack
time.

The descriptor written by pack looks like:

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

### NuGet Package

```yaml
- type: nuget
  name: MyOrg.Package
  path: bin/Release/MyOrg.Package.1.0.0.nupkg
  registries: [nuget, github-nuget]
```

`nuget` copies a `.nupkg` the build already produced and does not control its version. For a
library you own, prefer `dotnet-lib`, which builds and packs at the release version.

### Release Attachment

```yaml
- type: release-attachment
  name: documentation.pdf
  path: docs/output/documentation.pdf
  contentType: application/pdf
```

### Deployment keys

Any artifact may carry deployment keys. They configure the deploy bundle, not the artifact:
`deploy` lists the methods to build bundles for (`compose`, `swarm`, `swarm-job`); `versioning`
is `singleton` (default) or `major`; `stack` and `service` override the names derived from the
package; `sharedStorage` and `seedStorage` declare persistent directories. See the wiki's
Deployment page.

## Resumability

The action checks existing draft releases before processing. If a project's
`{project}.artifact.yml` is already uploaded to its draft release, that project is skipped. This
allows re-running the workflow without rebuilding completed projects.

## Smart Dependencies

The action automatically discovers and builds all workspace dependencies, but only packs and
uploads projects explicitly listed in the PR metadata. This ensures dependencies are fresh without
creating unnecessary releases.

## License

MIT
