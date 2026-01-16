# @cpdevtools/git-flow

Git-based versioning and release workflow automation.

## Packages

- [`@cpdevtools/git-flow`](./packages/git-flow) - Core library for version resolution and branch operations
- [`create-release-pr`](./actions/create-release-pr) - GitHub composite action for creating release PRs

## Workflows

- [Create Release PR](./.github/workflows/create-release-pr.yml) - Reusable workflow for automating release PRs

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
