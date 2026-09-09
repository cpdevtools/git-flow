# Publish Release Action

GitHub composite action for publishing artifacts to registries and finalizing releases. Runs after
`build-pack` against the same merged release PR.

## Usage

```yaml
- uses: cpdevtools/git-flow/actions/publish-release@main
  with:
    pr-number: ${{ github.event.pull_request.number }}
    token: ${{ secrets.GITHUB_TOKEN }}
  env:
    # Registry tokens from secrets
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
    NUGET_API_KEY: ${{ secrets.NUGET_API_KEY }}
    DOCKERHUB_USERNAME: ${{ secrets.DOCKERHUB_USERNAME }}
    DOCKERHUB_TOKEN: ${{ secrets.DOCKERHUB_TOKEN }}
```

Check out `${{ github.event.pull_request.merge_commit_sha }}`, not the branch head.

## Inputs

- `pr-number` (required): Release PR number
- `token` (required): GitHub token with `contents: write`, `packages: write`, `pull-requests: write`

## Outputs

- `published-count`: Number of projects successfully published
- `verified-count`: Number of projects verified
- `failed-count`: Number of projects that failed

## Environment Variables

Registry authentication is passed via environment variables. Each registry entry's `auth` field
names the variable to read (never the token itself), so the set depends on your registries:

- `GITHUB_TOKEN` - GitHub Packages (npm, NuGet) and ghcr.io
- `NPM_TOKEN` - npmjs.com
- `NUGET_API_KEY` - nuget.org
- `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` - Docker Hub (`usernameEnv` + `auth`)

Registry configuration is defined in `.publish/registries.yml` in your repository.

## How It Works

1. Downloads artifacts from the draft GitHub Releases created by `build-pack`
2. Reads the `<project>.artifact.yml` descriptors
3. Publishes artifacts to their configured registries, in dependency order. Docker images are
   `docker load`ed from the saved tarball, verified against the recorded `digest`, then tagged and
   pushed under the release version and any floating tags (`latest`, `next`, channel) the version
   earns
4. Verifies successful publication against each registry
5. Creates git tags and converts draft releases to published

Publishing dispatches through the artifact-type registry, so any plugin the repository installs is
resolved here as well as at pack time.

## Error Handling

- **Fail-fast**: Stops on first error
- **Idempotent**: Skips already published versions
- **Clear errors**: Shows exactly which project failed
