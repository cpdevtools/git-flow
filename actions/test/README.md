# Test Action

Runs build/test scripts across all workspace projects in dependency order using the
[`@cpdevtools/ts-dev-utilities`](https://github.com/cpdevtools/ts-dev-utilities) parallel script
runner.

Projects start as soon as all their workspace dependencies have passed — not in fixed waves. Failed
projects automatically cause their dependents to be skipped.

There is no change detection. Every run executes all applicable scripts across the whole
workspace.

## Usage

```yaml
- uses: cpdevtools/git-flow/actions/test@main
  with:
    mode: test-optional
```

Full example with all options:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      checks: write
    steps:
      - uses: actions/checkout@v7
      - uses: cpdevtools/git-flow/actions/test@main
        with:
          mode: test-optional
          fail-fast: false
          concurrency: 4
          token: ${{ secrets.GITHUB_TOKEN }}
```

The action installs Node, pnpm and the workspace itself, so no setup steps are needed before it.

## Inputs

| Input            | Default                   | Description                                                     |
| ---------------- | ------------------------- | --------------------------------------------------------------- |
| `mode`           | `test-optional`           | Which scripts to run. See [Mode mapping](#mode-mapping) below. |
| `fail-fast`      | `false`                   | Stop on first failure, cancelling in-flight tasks.             |
| `concurrency`    | _(unlimited)_             | Maximum number of projects to run in parallel.                 |
| `token`          | `${{ github.token }}`     | GitHub token used for installing packages.                     |
| `workspace-root` | `${{ github.workspace }}` | Root directory to discover projects from.                      |

## Outputs

| Output             | Description                                              |
| ------------------ | -------------------------------------------------------- |
| `projects-passed`  | Number of projects that passed.                          |
| `projects-failed`  | Number of projects that failed.                          |
| `projects-skipped` | Number of projects skipped because a dependency failed.  |

## Mode Mapping

`mode` selects **script names**, not behaviours:

| Mode            | Scripts run per project                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `build`         | `github.actions.build`                                                     |
| `test`          | `github.actions.test`                                                      |
| `test-optional` | `github.actions.build` then `github.actions.test` (whichever are defined) |

A project that defines none of the target scripts is reported as `no-script` and the run still
passes. A repository whose tests live under a plain `test` script therefore goes green without
running anything — name the script `github.actions.test`, and check with `devutil discover`
rather than assuming.

## Task Outcomes

| Outcome     | Meaning                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `passed`    | All target scripts exited 0.                                                 |
| `failed`    | A script exited non-zero.                                                    |
| `skipped`   | A workspace dependency failed — this project was not run.                    |
| `cancelled` | `fail-fast` was set and a failure occurred while this task was in flight.    |
| `no-script` | None of the target scripts are defined in this project. Counts as a pass.    |

## Step Summary

The action writes a results table to the GitHub Actions step summary, and creates an error
annotation for each failed project with its captured output (up to 1 MB per task).
