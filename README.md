# @cpdevtools/git-flow

Git-based versioning and release workflow automation.

## Packages

- [`@cpdevtools/git-flow`](./packages/git-flow) - Core library for version resolution and branch operations
- [`create-release-pr`](./actions/create-release-pr) - GitHub composite action for creating release PRs

## Actions

- [`test`](./actions/test) - Runs build/test scripts across workspace projects in dependency order using [`@cpdevtools/ts-dev-utilities/runner`](https://github.com/cpdevtools/ts-dev-utilities)

**Inputs:**

| Input | Default | Description |
|-------|---------|-------------|
| `mode` | `test-optional` | `build`, `test`, or `test-optional` (both where available) |
| `fail-fast` | `false` | Stop on first failure, cancel in-flight tasks |
| `concurrency` | _(unlimited)_ | Max projects to run in parallel |
| `workspace-root` | `${{ github.workspace }}` | Workspace root |

**Outputs:** `projects-passed`, `projects-failed`, `projects-skipped`

## Workflows

- [Create Release PR](./.github/workflows/create-release-pr.yml) - Reusable workflow for automating release PRs
- [Test](./.github/workflows/test.yml) - Runs build/test scripts across the workspace on every push

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Lint
pnpm lint

# Format
pnpm format
```

## License

MIT
# Git-Flow Release Test
# Trigger new PR
# Retrigger

