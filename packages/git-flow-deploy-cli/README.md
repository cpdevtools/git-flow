# @cpdevtools/git-flow-deploy-cli

Server-side CLI for the deploy gateway. Binary: **`deploy-gateway`**.

Installed on the deploy host — typically inside a gateway's runtime image — and used two ways: by an
operator, and by a gateway service shelling out to it.

> **The point of this package.** A gateway should be a thin HTTP shell over this CLI. Anything the
> service decides, a person watching the request arrive must be able to reproduce by hand with
> `deploy-gateway …` and get the same answer. When a gateway needs a capability the CLI lacks, extend
> the CLI — do not reimplement the rule in the service, where the two copies will drift.

## Install

```bash
npm install -g @cpdevtools/git-flow-deploy-cli
```

## Exit codes

Commands are designed to be called by another program, so the exit code *is* the answer:

| Code | Meaning |
|---|---|
| `0` | Yes / allowed / valid / converged |
| `1` | No / denied / invalid / rolled back |
| `2` | Undecidable — could not determine |

A caller must treat `2` as failure, never as a pass. Missing binary, timeout, and corrupt rules file
all fail **closed**.

## Commands

### Deploy

```bash
# Fetch + run in one shot
deploy-gateway deploy owner/repo 123456789 --bundle deploy-swarm.zip \
  [--dest /tmp/my-deploy] [--shared-storage-base /docker-nfs/swarm]

# Or the two stages separately
deploy-gateway fetch owner/repo 123456789 --bundle deploy-swarm.zip --dest <dir>
deploy-gateway run --work-dir <dir> [--manifest <path>] [--shared-storage-base <path>]
```

`--bundle` is **required**: releases carry per-method bundles (`deploy-swarm.zip`,
`deploy-compose.zip`, …), not a generic `deploy.zip`.

`fetch` prints a `DEPLOY_TARGET_VERSION:<version>` line. A gateway performing a self-update should
intercept it — that version is what later proves the replacement instance is the one just installed.

`run` streams stdout and stderr, and for a swarm manifest with a `swarmService` it additionally waits
for convergence rather than returning as soon as `docker stack deploy` accepts the spec.

### Signatures

```bash
deploy-gateway hmac sign   --timestamp <ts> < body.json
deploy-gateway hmac verify --signature <sig> --timestamp <ts> --quiet < body.json
```

Body arrives on **stdin** so the raw bytes are preserved. `verify` exits `0` valid, `1` rejected,
`2` undecidable.

### Repo allowlist

```bash
deploy-gateway repos check owner/repo --quiet   # 0 allowed, 1 denied, 2 undecidable
deploy-gateway repos list
deploy-gateway repos allow add|list|remove <pattern>
deploy-gateway repos deny  add|list|remove <pattern>
```

Minimatch patterns, deny wins. An absent config permits everything — seed one.

### Swarm

```bash
deploy-gateway swarm status <stack>   # 0 converged, 1 rolled-back, 2 undetermined
```

`converged` means the rollout finished, **not** that it installed what you asked for. Confirm the
running version separately.

## Secrets

Every secret resolves `<NAME>_FILE` before `<NAME>`, so swarm secrets — which are mounted as files
under `/run/secrets`, not exported as env values — work without a wrapper. `GITHUB_TOKEN_FILE`,
`DEPLOY_HMAC_SECRET_FILE`, and so on.

`SHARED_STORAGE_BASE_DIR` supplies the default for `--shared-storage-base`.

## Development

```bash
pnpm build   # tsup + oclif manifest
```

## License

MIT
