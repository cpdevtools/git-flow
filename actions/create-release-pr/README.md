# Create Release PR Action

GitHub composite action to create release pull requests with version metadata.

## Usage

```yaml
- uses: cpdevtools/git-flow/actions/create-release-pr@v1
  with:
    branch: main
    token: ${{ secrets.GITHUB_TOKEN }}
    versions-file: .github/versions.json
    run-number: ${{ github.run_number }}
```

## Inputs

- `branch` - Source branch name (default: current branch)
- `token` - GitHub token with PR permissions (default: `${{ github.token }}`)
- `versions-file` - Path to versions configuration file (default: `.github/versions.json`)
- `run-number` - CI run number for build suffix (default: `${{ github.run_number }}`)

## Outputs

- `pr-number` - Pull request number
- `pr-url` - Pull request URL
- `release-branch` - Name of the release branch

## Versions File Format

```json
{
  "0.0.0-DEFAULT": "2.0.0",
  "0.0.0-V1_8_LTS": "1.8.5",
  "0.0.0-BETA": "2.0.0-beta.0"
}
```

## Development

```bash
# Install dependencies
pnpm install

# Build action
pnpm run build

# Test
pnpm test

# Lint
pnpm run lint
```

## License

MIT
