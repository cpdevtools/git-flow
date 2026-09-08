# Create Release PR Action

GitHub composite action that ensures the `release/<branch>` branch exists and creates or updates the
draft release pull request, writing the resolved versions into its body as YAML metadata.

## Usage

```yaml
- uses: cpdevtools/git-flow/actions/create-release-pr@main
  with:
    branch: ${{ github.ref_name }}
    token: ${{ secrets.GITHUB_TOKEN }}
    run-number: ${{ github.run_number }}
```

## Inputs

- `branch` - Source branch name (default: `${{ github.ref_name }}`)
- `token` - GitHub token with `contents: write` and `pull-requests: write` (default:
  `${{ github.token }}`)
- `versions-file` - Path to the versions file (supports `.json`, `.yml`, `.yaml`). Default empty:
  the action resolves `.publish/versions.yml`, falling back to `.github/versions.yml`. Pass it only
  to use another path.
- `run-number` (required) - CI run number, used for the build suffix when a version is already
  released. Pass `${{ github.run_number }}`.

## Outputs

- `pr-number` - Pull request number
- `pr-url` - Pull request URL
- `release-branch` - Name of the release branch (`release/<branch>`)

## Versions File Format

`.publish/versions.yml` maps version keys to the version each key currently targets. `MAIN` is the
default key:

**YAML (.yml or .yaml):**

```yaml
0.0.0-MAIN: 2.0.0
0.0.0-BETA: 2.0.0-beta.0
```

**JSON (.json):**

```json
{
  "0.0.0-MAIN": "2.0.0",
  "0.0.0-BETA": "2.0.0-beta.0"
}
```

The file is branch-specific: a maintenance branch such as `v1.8` carries its own `0.0.0-MAIN`
value.

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
