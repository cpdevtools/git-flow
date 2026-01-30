# Publish Release Action

GitHub composite action for publishing artifacts to registries and finalizing releases (Phase 3).

## Usage

```yaml
- uses: cpdevtools/git-flow/actions/publish-release@main
  with:
    pr-number: ${{ github.event.pull_request.number }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
  env:
    # Registry tokens from secrets
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
    NUGET_API_KEY: ${{ secrets.NUGET_API_KEY }}
    DOCKER_USERNAME: ${{ secrets.DOCKER_USERNAME }}
    DOCKER_TOKEN: ${{ secrets.DOCKER_TOKEN }}
```

## Inputs

- `pr-number` (required): Release PR number
- `github-token` (required): GitHub token for API access

## Outputs

- `published-count`: Number of projects successfully published
- `verified-count`: Number of projects verified
- `failed-count`: Number of projects that failed

## Environment Variables

All registry authentication tokens are passed via environment variables:

- `NPM_TOKEN` - NPM registry authentication
- `NUGET_API_KEY` - NuGet registry authentication  
- `DOCKER_USERNAME` - Docker registry username
- `DOCKER_TOKEN` - Docker registry token
- Additional tokens can be added as needed

Registry configuration is defined in `.github/registries.yml` in your repository.

## How It Works

1. Downloads artifacts from draft GitHub Releases (created in Phase 2)
2. Reads artifact.yml descriptors
3. Publishes artifacts to configured registries (in dependency order)
4. Verifies successful publication
5. Converts draft releases to published
6. Creates git tags

## Error Handling

- **Fail-fast**: Stops on first error
- **Idempotent**: Skips already published versions
- **Clear errors**: Shows exactly which project failed
