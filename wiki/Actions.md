# Actions and Workflows

Eight composite actions, referenced as `cpdevtools/git-flow/actions/<name>@main`. A managed
repository's own workflows are thin wrappers around them — see
[Repository Structure](Repository-Structure).

| Action                                      | Purpose                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| [`create-release-pr`](#create-release-pr)   | Ensure the release branch and keep the draft release pull request current |
| [`test`](#test)                             | Run build and test scripts across the workspace in dependency order       |
| [`test-integration`](#test-integration)     | The same, for integration scripts, on pull requests                       |
| [`build-pack`](#build-pack)                 | Build and pack release artifacts from a release pull request              |
| [`publish-release`](#publish-release)       | Publish to registries and finalise the releases                           |
| [`deploy`](#deploy)                         | Send a signed deploy request to a gateway and stream the log back         |
| [`cleanup-old-builds`](#cleanup-old-builds) | Prune superseded prerelease builds                                        |
| [`publish-wiki`](#publish-wiki)             | Mirror a repository directory into the repository's GitHub wiki           |

Every action takes a `token` input defaulting to `${{ github.token }}`.

---

## `create-release-pr`

```yaml
- uses: cpdevtools/git-flow/actions/create-release-pr@main
  with:
    branch: ${{ github.ref_name }}
    versions-file: .publish/versions.yml
    run-number: ${{ github.run_number }}
```

| Input           | Default                  | Description                                                   |
| --------------- | ------------------------ | ------------------------------------------------------------- |
| `branch`        | `${{ github.ref_name }}` | Source branch                                                 |
| `versions-file` | `.github/versions.yml`   | Path to the versions file — set it to `.publish/versions.yml` |
| `run-number`    | _(required)_             | Used for the build suffix when a version is already released  |
| `token`         | `${{ github.token }}`    | Needs `contents: write`, `pull-requests: write`               |

**Outputs:** `pr-number`, `pr-url`, `release-branch`.

> The default for `versions-file` is the legacy `.github/` location. Set it explicitly unless your
> versions file lives there.

## `test`

```yaml
- uses: cpdevtools/git-flow/actions/test@main
  with:
    mode: test-optional
```

| Input            | Default                   | Description                                       |
| ---------------- | ------------------------- | ------------------------------------------------- |
| `mode`           | `test-optional`           | `build`, `test`, or `test-optional`               |
| `fail-fast`      | `false`                   | Stop on first failure, cancelling in-flight tasks |
| `concurrency`    | _(unlimited)_             | Maximum projects in parallel                      |
| `workspace-root` | `${{ github.workspace }}` | Workspace root                                    |

**Outputs:** `projects-passed`, `projects-failed`, `projects-skipped`.

| `mode`          | Scripts run per project                            |
| --------------- | -------------------------------------------------- |
| `build`         | `github.actions.build`                             |
| `test`          | `github.actions.test`                              |
| `test-optional` | `github.actions.build`, then `github.actions.test` |

> **`mode` selects script names, not behaviours.** A project defining neither script is reported as
> _no-script_ and the run still passes, so a repository whose tests live under a plain `test` script
> will go green without running anything. See [Gotchas](Gotchas).

The action is a reporting adapter over the parallel runner in
[`@cpdevtools/ts-dev-utilities`](https://github.com/cpdevtools/ts-dev-utilities/wiki/Parallel-Script-Runner):
it maps `mode` to script names, calls `runScripts`, and renders annotations and a step summary, with
each failed project's captured output inlined.

## `test-integration`

The same engine against integration scripts, intended for pull requests.

| Input            | Default                   |
| ---------------- | ------------------------- |
| `fail-fast`      | `false`                   |
| `concurrency`    | _(unlimited)_             |
| `workspace-root` | `${{ github.workspace }}` |

## `build-pack`

```yaml
- uses: cpdevtools/git-flow/actions/build-pack@main
  with:
    pr-number: ${{ github.event.pull_request.number }}
```

| Input            | Default                   | Description                                                      |
| ---------------- | ------------------------- | ---------------------------------------------------------------- |
| `pr-number`      | `0`                       | The merged release pull request, whose body carries the metadata |
| `workspace-root` | `${{ github.workspace }}` | Workspace root                                                   |
| `token`          | `${{ github.token }}`     | Needs `contents: write`, `pull-requests: read`, `packages: read` |

Check out `${{ github.event.pull_request.merge_commit_sha }}`, not the branch head.

## `publish-release`

```yaml
- uses: cpdevtools/git-flow/actions/publish-release@main
  with:
    pr-number: ${{ github.event.pull_request.number }}
    token: ${{ secrets.GITHUB_TOKEN }}
```

| Input       | Required | Description                                                        |
| ----------- | -------- | ------------------------------------------------------------------ |
| `pr-number` | yes      | The merged release pull request                                    |
| `token`     | yes      | Needs `contents: write`, `packages: write`, `pull-requests: write` |

## `deploy`

Signs and POSTs a deploy trigger to the gateway, then streams the log until the run reports its exit
code.

| Input             | Default                                 | Description                                       |
| ----------------- | --------------------------------------- | ------------------------------------------------- |
| `release_id`      | _(required)_                            | Release ID or tag, e.g. `@org/api/v1.2.3`         |
| `repo`            | `${{ github.repository }}`              | Repository the release belongs to                 |
| `deploy_url`      | from `DEPLOY_URL`                       | Gateway base URL                                  |
| `hmac_secret`     | from `DEPLOY_HMAC_SECRET`               | Shared signing secret                             |
| `deploy_type`     | from `DEPLOY_TYPE_DEFAULT`, then `node` | Method, selecting `deploy-<type>.zip`             |
| `bundle`          | `deploy-<type>.zip`                     | Explicit asset name, overriding `deploy_type`     |
| `environment`     | _(none)_                                | GitHub Environment name, for Deployments tracking |
| `deploy_env`      | _(none)_                                | Extra environment for the deploy run              |
| `allowed_methods` | _(none)_                                | Methods this environment permits                  |

Most inputs fall back to environment variables so a `deploy-<env>.yml` wrapper can source them from
the GitHub Environment rather than hardcoding them. See [Deployment](Deployment).

## `cleanup-old-builds`

| Input      | Default               | Description                                |
| ---------- | --------------------- | ------------------------------------------ |
| `days-old` | `14`                  | Delete builds older than this              |
| `dry-run`  | `false`               | Report without deleting                    |
| `token`    | `${{ github.token }}` | Needs `contents: write`, `packages: write` |

Removes `.build.*` releases, their tags, and the matching GitHub Packages versions. Only build
versions are touched.

## `publish-wiki`

Mirrors a directory in the repository into the repository's GitHub wiki, so wiki pages are reviewed
in the same pull request as the code they document.

| Input        | Default                      | Description                                         |
| ------------ | ---------------------------- | --------------------------------------------------- |
| `source`     | `wiki`                       | Directory holding the pages                         |
| `repository` | `${{ github.repository }}`   | Whose wiki to publish to                            |
| `message`    | `docs: sync wiki from <sha>` | Commit message                                      |
| `checkout`   | `true`                       | Set `false` when a previous step generated `source` |
| `dry-run`    | `false`                      | Report without pushing                              |
| `token`      | `${{ github.token }}`        | Needs `contents: write`                             |

**Outputs:** `changed`, `pages`.

---

## Reusable workflows

Called with `uses:` at the job level rather than the step level.

| Workflow                                                            | Wraps                |
| ------------------------------------------------------------------- | -------------------- |
| `cpdevtools/git-flow/.github/workflows/cleanup-old-builds.yml@main` | `cleanup-old-builds` |
| `cpdevtools/git-flow/.github/workflows/publish-wiki.yml@main`       | `publish-wiki`       |

```yaml
jobs:
  cleanup:
    uses: cpdevtools/git-flow/.github/workflows/cleanup-old-builds.yml@main
    with:
      days_old: '14'
      dry_run: 'false'
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
```

Reusable-workflow inputs are `snake_case`, while action inputs are `kebab-case`.
