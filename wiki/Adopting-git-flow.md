# Adopting git-flow

Putting an existing repository on git-flow. Roughly an afternoon for a straightforward workspace;
the application code usually needs no changes at all, because what is being replaced is the release
and deploy envelope around it.

## 1. Install

```ini
# .npmrc
@cpdevtools:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
pnpm add -D -w @cpdevtools/git-flow @cpdevtools/git-flow-cli
```

## 2. Replace every version with a placeholder

Set `"version": "0.0.0-MAIN"` in the workspace root manifest and in every project manifest. Projects
sharing the placeholder release together under one version number; see [Versioning](Versioning).

## 3. Add `.publish/`

```yaml
# .publish/versions.yml — the real version, on this branch
'0.0.0-MAIN': 1.0.0-dev.0
```

```yaml
# .publish/registries.yml — where things get published
registries:
  github-npm:
    type: npm
    url: https://npm.pkg.github.com
    auth: GITHUB_TOKEN
    scope: '@org'
```

Start `versions.yml` below your current released version if you have one — the first release from
git-flow should move forward, not collide.

## 4. Name the scripts

Rename each project's build and test entry points to the names the pipeline calls, and add a pack
script for anything that publishes:

```jsonc
"scripts": {
  "build": "tsup",                        // keep your own for local use
  "github.actions.build": "pnpm build",
  "github.actions.test": "pnpm test",
  "github.actions.pack": "gitflow pack"
}
```

> Getting `github.actions.test` wrong is the single most common adoption mistake. A project that
> does not define it is reported as _no-script_ and CI goes green without running its tests. Verify
> with `devutil discover` that the script exists where you think it does.

## 5. Declare artifacts

One `release-artifacts.yml` per publishable project:

```yaml
artifacts:
  - type: npm
    name: '${PACKAGE_NAME}'
    registries:
      - github-npm
```

Projects with no such file are built and tested but never published. See [Artifacts](Artifacts).

## 6. Add the workflows

Four files, each a thin wrapper. See [Actions and Workflows](Actions) for the full inputs.

```yaml
# .github/workflows/create-release-pr.yml
name: Create Release PR
on:
  push:
    branches-ignore: ['release/**']
jobs:
  create-release-pr:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      packages: read
    steps:
      - uses: actions/checkout@v7
      - uses: cpdevtools/git-flow/actions/create-release-pr@main
        with:
          branch: ${{ github.ref_name }}
          versions-file: .publish/versions.yml
          run-number: ${{ github.run_number }}
```

```yaml
# .github/workflows/test.yml
name: Test
on:
  push:
    branches-ignore: ['release/**']
permissions:
  checks: write
  actions: read
  packages: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: cpdevtools/git-flow/actions/test@main
        with:
          mode: test-optional
```

```yaml
# .github/workflows/build-pack-publish.yml
name: Build, Pack & Publish
on:
  pull_request:
    types: [closed]
    branches: ['release/**']
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

  publish-release:
    needs: build-pack
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    permissions:
      contents: write
      packages: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.merge_commit_sha }}
      - uses: cpdevtools/git-flow/actions/publish-release@main
        with:
          pr-number: ${{ github.event.pull_request.number }}
          token: ${{ secrets.GITHUB_TOKEN }}
```

```yaml
# .github/workflows/cleanup-scheduled.yml
name: Scheduled Cleanup
on:
  schedule: [{ cron: '0 2 * * *' }]
  workflow_dispatch:
jobs:
  cleanup:
    uses: cpdevtools/git-flow/.github/workflows/cleanup-old-builds.yml@main
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
```

## 7. Rename maintenance branches

Any long-lived branch that must publish stable patches has to lose its slash: `v/1.8` becomes
`v1.8`. A slashed branch can only ever publish pre-releases, and it does so quietly. See
[Branch Model](Branch-Model).

## 8. First run

```bash
gitflow version      # choose the first version
git push             # a draft release PR appears
```

Check the pull request body before merging. It lists every project being released and the version
each will get. If a project is missing, it has no `release-artifacts.yml`; if a version is not what
you expected, `.publish/versions.yml` on this branch is the place to look.

Merge, and watch `build-pack-publish`.

## 9. Deployment, if applicable

Add `.deploy/<method>/` to deployable projects, a `deploy:` key on their artifacts, and one
`deploy-<env>.yml` per environment, with that environment's settings held as GitHub Environment
variables and secrets. See [Deployment](Deployment).

## Checklist

- [ ] `.npmrc` points `@cpdevtools` at GitHub Packages
- [ ] Every manifest carries `0.0.0-<KEY>`
- [ ] `.publish/versions.yml` and `.publish/registries.yml` exist
- [ ] Each project defines the `github.actions.*` scripts it needs
- [ ] `github.actions.test` is the actual test script — verified, not assumed
- [ ] Each publishable project has `release-artifacts.yml`
- [ ] Four workflows added, with the right permissions
- [ ] Maintenance branches have no `/` in the name
- [ ] Release pull request reviewed before the first merge
