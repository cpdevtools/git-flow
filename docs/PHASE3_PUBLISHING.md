# Phase 3: Publishing System

Complete implementation for publishing artifacts to registries and finalizing releases.

## Components

### 1. Registry Configuration System

Flexible registry authentication via `.github/registries.yml`:

```yaml
registries:
  npm:
    type: npm
    url: https://registry.npmjs.org
    auth: NPM_TOKEN # Env var name
    scope: '@myorg'

  dockerhub:
    type: docker
    registry: docker.io
    namespace: myorg
    auth: DOCKERHUB_TOKEN
    usernameEnv: DOCKERHUB_USERNAME
```

See [.github/registries.example.yml](../.github/registries.example.yml) for full example.

### 2. Publishing Utilities

Located in `packages/git-flow/src/publishing/`:

- **[registry-config.ts](../packages/git-flow/src/publishing/registry-config.ts)**: Load and validate registry config
- **[publishers.ts](../packages/git-flow/src/publishing/publishers.ts)**: Publish to NPM, NuGet, Docker
- **[verification.ts](../packages/git-flow/src/publishing/verification.ts)**: Verify successful publication

### 3. Workspace Dependencies

Located in `packages/git-flow/src/build-pack/workspace-deps/`:

- **[npm.ts](../packages/git-flow/src/build-pack/workspace-deps/npm.ts)**: Rewrite `workspace:*` → version
- **[nuget.ts](../packages/git-flow/src/build-pack/workspace-deps/nuget.ts)**: Convert `ProjectReference` → `PackageReference`
- **[docker.ts](../packages/git-flow/src/build-pack/workspace-deps/docker.ts)**: Verify image tags

### 4. Publish-Release Action

Composite GitHub Action at `actions/publish-release/`:

```yaml
- uses: cpdevtools/git-flow/actions/publish-release@main
  with:
    pr-number: ${{ github.event.pull_request.number }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
  env:
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
    NUGET_API_KEY: ${{ secrets.NUGET_API_KEY }}
    DOCKERHUB_TOKEN: ${{ secrets.DOCKERHUB_TOKEN }}
```

## Features

### ✅ Flexible Registry Authentication

- Unlimited registries supported
- Tokens passed via workflow `env:` block
- No hard-coded inputs in action.yml

### ✅ Workspace Dependency Rewriting

- Automatically rewrites workspace dependencies before packing
- NPM: `workspace:*` → actual version
- NuGet: `ProjectReference` → `PackageReference`
- Restores original files after packing

### ✅ Docker Digest Verification

- Pulls temp image from Phase 2
- Verifies digest matches
- Prevents publishing tampered images
- Retags with final version and `latest`

### ✅ Fail-Fast Error Handling

- Stops on first error
- Clear error messages
- No automatic rollback (manual intervention required)

### ✅ Idempotent Publication

- Checks if version already published
- Skips already-published artifacts
- Safe to retry

## Workflow

```
Phase 3: Publish Release
├─ Load .github/registries.yml
├─ For each project (in dependency order):
│  ├─ Download artifact.yml from GitHub Release
│  ├─ For each artifact:
│  │  ├─ Check if already published (skip if yes)
│  │  ├─ Publish to configured registries
│  │  └─ Verify publication
│  ├─ Finalize GitHub Release (draft → published)
│  └─ Create git tag (project/vX.Y.Z)
└─ Done
```

## Error Handling

- **Already published**: Skipped with info message
- **Publication fails**: Stop immediately, report error
- **Verification fails**: Stop immediately, report error
- **Network issues**: Fail with clear message

## Registry Types

### NPM

- Supports scoped packages (`@org/package`)
- Creates temporary `.npmrc` with auth
- Publishes tarball to registry

### NuGet

- Uses `dotnet nuget push`
- Supports custom registry URLs
- API key authentication

### Docker

- Multi-step: pull → verify → retag → push
- Digest verification (security)
- Pushes both version tag and `latest`
- Cleanup of temp tags

## Security

- ✅ All secrets via environment variables
- ✅ No secrets in logs
- ✅ Docker digest verification
- ✅ Registry URL validation
- ✅ Token validation before use

## Testing

```bash
# Build packages
cd git-flow
pnpm build

# Test publish action
cd actions/publish-release
pnpm build

# Manual test (requires valid registries.yml and tokens)
cd git-flow/packages/git-flow
pnpm build
node dist/publish-release/orchestrate.js
```

## Next Steps

1. ✅ Core implementation complete
2. ⏳ Integration testing with real registries
3. ⏳ Unit tests for publishing utilities
4. ⏳ End-to-end workflow testing
5. ⏳ Documentation polish
