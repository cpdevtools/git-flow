# Repository Structure

What a repository managed by git-flow looks like. For what an individual project inside it has to
provide, see [Project Structure](Project-Structure).

```
my-repo/
├── .publish/
│   ├── versions.yml            # version keys → real versions  (branch-specific)
│   ├── registries.yml          # named publish destinations
│   └── deps.yml                # optional: pinned dependency versions
├── .github/
│   └── workflows/
│       ├── create-release-pr.yml
│       ├── test.yml
│       ├── build-pack-publish.yml
│       └── cleanup-scheduled.yml
├── .npmrc                      # scope → registry, for installing git-flow itself
├── pnpm-workspace.yaml
├── package.json                # workspace root: private, version 0.0.0-<KEY>
└── packages/
    ├── api/
    │   ├── package.json        # version 0.0.0-<KEY>, github.actions.* scripts
    │   ├── release-artifacts.yml
    │   └── .deploy/            # only for deployable projects
    └── web/
        └── …
```

Nothing here is discovered by convention _except_ the projects themselves — every file above is
looked for at a fixed path.

## `.publish/`

Release configuration lives in its own directory rather than under `.github/`, because it is not
GitHub configuration: the CLI reads it locally, and the same files would apply if the pipeline ran
somewhere else. `versions.yml` is also accepted at `.github/versions.yml`.

### `versions.yml`

Maps each version key to the real version on **this branch**.

```yaml
'0.0.0-MAIN': 2.2.0-dev.0
'0.0.0-BETA': 1.0.0-beta.0
```

Being branch-specific is the point, not an accident — it is how a maintenance branch stays on its
own track while sharing a key with `main`. Written by `gitflow version`; see
[Versioning](Versioning).

### `registries.yml`

Named destinations that artifacts refer to by ID. See [Registries](Registries).

```yaml
registries:
  github-npm:
    type: npm
    url: https://npm.pkg.github.com
    auth: GITHUB_TOKEN
    scope: '@cpdevtools'
```

### `deps.yml`

Optional. One declared version per dependency, applied across `package.json`, `.csproj`,
Dockerfiles and workflow files by
[`devutil dep-versions`](https://github.com/cpdevtools/ts-dev-utilities/wiki/Dependency-Versions).
Not read by git-flow itself — it is a companion tool that keeps a repository's dependency versions
consistent.

## Workflows

A managed repository's workflows are thin. All the behaviour is in the actions; the workflow files
exist to declare triggers and permissions.

| File                     | Trigger                                                              | Calls                                           |
| ------------------------ | -------------------------------------------------------------------- | ----------------------------------------------- |
| `create-release-pr.yml`  | `push`, `branches-ignore: release/**`                                | `cpdevtools/git-flow/actions/create-release-pr` |
| `test.yml`               | `push`, `branches-ignore: release/**`                                | `cpdevtools/git-flow/actions/test`              |
| `build-pack-publish.yml` | `pull_request` `closed` on `release/**`, guarded by `merged == true` | `build-pack`, then `publish-release`            |
| `cleanup-scheduled.yml`  | `schedule`, `workflow_dispatch`                                      | the `cleanup-old-builds` reusable workflow      |

Add `deploy-<env>.yml` per environment for deployable repositories — the environment list is
discovered from those filenames. See [Deployment](Deployment).

Full inputs are in [Actions and Workflows](Actions).

## The workspace root

```jsonc
{
  "name": "@org/my-repo",
  "version": "0.0.0-MAIN",
  "private": true,
  "packageManager": "pnpm@11.5.0",
  "devDependencies": {
    "@cpdevtools/git-flow": "…",
    "@cpdevtools/git-flow-cli": "…",
  },
}
```

The root carries a placeholder version like everything else, and is `private` — it is not a
publishable project.

## How projects are found

git-flow searches the repository for **every `package.json`**, ignoring `node_modules`,
`.pnpm-prod`, `.wireit`, `dist` and `.docker-bundle`, and never following symlinks. A directory
containing a `pnpm-workspace.yaml` is treated as a workspace root and skipped.

Two consequences:

- **Projects do not have to live under `packages/`.** Any directory with a named `package.json` is a
  project. A `projects/` layout, or projects at the repository root, work the same way.
- **A stray `package.json` becomes a project.** A fixture or an example directory with a manifest
  will appear in the build set. Keep those out of the repository, or under an ignored path.

Being discovered does not mean being released. A project is released only if the release pull
request's metadata names it, which happens only when it has something to publish — see
[Project Structure](Project-Structure).

## Installing git-flow

`@cpdevtools/*` packages are published to GitHub Packages, so a managed repository needs an
`.npmrc`:

```ini
@cpdevtools:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

and jobs that install need `permissions: packages: read`.

If your repository releases packages that git-flow itself consumes, or vice versa, exclude them from
pnpm's minimum-release-age check so a release is usable the day it publishes:

```yaml
# pnpm-workspace.yaml
minimumReleaseAgeExclude:
  - '@cpdevtools/git-flow'
  - '@cpdevtools/git-flow-cli'
```

Use bare package names. pnpm stops at the first entry matching a package, so a `name@version` entry
shadows every later entry for that package.
