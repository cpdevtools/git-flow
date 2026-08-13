# @cpdevtools/git-flow-deploy-service

The **reference implementation** of the git-flow deploy gateway: a NestJS HTTP service that runs on a
deploy host, receives signed deploy requests from GitHub Actions, and executes them.

> This package is a reference, not a mandate. It is a complete, working gateway — and it is also the
> most demanding consumer of its own pipeline, because it can deploy *itself*. A client
> implementation does not have to be a fork of this service, or even be written in TypeScript; it has
> to honour the same HTTP contract and the same `deploy.yml` bundle shape. `IdealSupply`'s gateway,
> for example, is a C# service that delegates every deploy decision to
> [`@cpdevtools/git-flow-deploy-cli`](../git-flow-deploy-cli).

## What it does

`actions/deploy` POSTs a signed webhook naming a repo and a GitHub Release id. The service downloads
that release's `deploy-<method>.zip` bundle, prepares shared storage, and runs the bundle's own
`deployCommand` — streaming every log line back to the workflow until a terminal `EXIT:<code>`.

Bundles never carry container images. `deploy.zip` is an **orchestration bundle only**; images always
come from the registry.

## Install

Bootstrap onto a host with the packaged CLI rather than by hand:

```bash
npx @cpdevtools/git-flow-deploy-service \
  --method swarm \          # node | compose | swarm
  --latest \                # or --version <x> / --next
  --token "$GITHUB_TOKEN" \
  --hmac-secret "$SECRET"
```

It resolves versions by listing releases tagged `@cpdevtools/git-flow-deploy-service/v*`, downloads
the bundle, derives the slot exactly as the bundle's own `deployCommand` does, records initial state,
and installs via npm+pm2, `docker compose -p <slot>`, or `docker stack deploy`.

## HTTP API

| Route | Auth | Purpose |
|---|---|---|
| `GET /status` | none | `{ ok, name, version }`. The version is what a self-update reads to confirm itself. |
| `POST /deploy` | HMAC | Start a deploy. `202` accepted · `200` already running (attaches an observer) · `400` bad manifest · `403` repo not allowed. |
| `GET /deploy/:id` | none | Status record. |
| `GET /deploy/:id/logs?from=N` | none | Chunked `text/plain` live stream. `from` may be negative to count back from the end. |

Request body is `DeployRequest { repo, release_id, bundle?, env? }`. Idempotency key is `release_id`.

**Signing.** `X-Deploy-Signature-256` is an HMAC-SHA256 over `"<timestamp>.<rawBody>"`, with
`X-Deploy-Timestamp` inside a ±60 s window. The algorithm lives in
[`@cpdevtools/git-flow-deploy`](../git-flow-deploy) so signer and verifier can never drift.

**Log framing.** Lines stream as they are produced, `:hb` every 5 s so proxies don't idle out, and a
terminal `EXIT:<code>` sentinel. Reconnect with `from` to resume at an offset.

> ⚠ The read endpoints are **anonymous**, matching the client, which sends no credentials when
> streaming logs. Deploy logs are readable by anything that can reach the gateway.

## Configuration

Read by `ConfigService`. Every secret resolves from the environment **or** `/run/secrets/<NAME>`, so
swarm secrets work unchanged.

| Variable | Required | Meaning |
|---|---|---|
| `DEPLOY_HMAC_SECRET` | yes | Shared secret for request signatures |
| `GITHUB_TOKEN` | yes | Reads Releases and pulls from ghcr |
| `DEPLOY_WORK_DIR` | no | Default `~/.git-flow-deploy-service/work` |
| `DEPLOY_STATE_DIR` | no | Default `~/.git-flow-deploy-service/state` |
| `SHARED_STORAGE_BASE_DIR` | no | Base for `prepareSharedStorage` |
| `DEPLOY_HOST_ROOT` | no | Host-side path prefix for bind mounts |
| `PORT` / `HOST` | no | Default `3700` / `0.0.0.0` |

`GITHUB_TOKEN` and `DEPLOY_HOST_ROOT` are seeded back into `process.env` so child deploy processes
inherit them.

The repo allow/deny list is hot-reloaded via `fs.watch` and **fails closed** — a read error keeps the
previous config rather than opening up. Matching rules live in `@cpdevtools/git-flow-deploy`, so the
service and the CLI always agree on what a pattern means.

## Deploying itself

Most of the complexity here exists because the service can be the thing being replaced. Four paths:

1. **Normal deploy** — run `deployCommand` inline; persist state on success; roll back to the prior
   mode if a mode change failed.
2. **Self mode-change** (e.g. node → compose) — hand a `SupervisorPlan` to a supervisor. A
   `container → host` transition is refused *before* anything is torn down, printing the manual
   recovery command.
3. **Containerized self redeploy** (compose/swarm) — hand off to a **sibling container**. A `setsid`
   supervisor would share this container's PID namespace and cgroup and be torn down with it.
4. **Node self update** — run inline; pm2 restarts the process, and the bundle's restart supervisor
   appends the terminal `EXIT` to the shared `deploy.log`, which the restarted process tails — or
   short-circuits by confirming it already runs `targetVersion`.

Self-container identification queries the Docker daemon **by label**
(`com.docker.compose.project` / `com.docker.stack.namespace`) rather than hostname, mountinfo, or
cgroup — all of which lie under `network_mode: container:<other>`. Override with
`DEPLOY_SELF_CONTAINER`.

### The one invariant you must not break

`SupervisorPlan` (`src/supervisor/plan.ts`) is **additive-only and optional-only**. During a
self-update the *outgoing* release's supervisor executes the plan written by the *incoming* one, so a
required new field, a renamed field, or a changed meaning breaks upgrades from every existing
version. Add optional fields; never repurpose one.

## Durability

`DeployStore` keeps a per-release record plus a durable append-only `deploy.log`. On boot it restores
in-flight records, reconciles terminal state from an `EXIT:` line, and tails the log for lines
appended by another process (500 ms poll, 5 min safety timeout). `DeploymentStateService` keeps
per-slot state at `<stateDir>/<slot>/state.json` alongside a retained copy of the running bundle, so
a future mode change can tear the old mode down using the old bundle's own files. State commits are
atomic: staged as `state.new.json`, then renamed.

## Development

```bash
pnpm build          # nest build + a second tsup pass for the CLI
pnpm test           # jest
pnpm build:docker   # prod bundle → node:24-alpine image
```

Tests are **Jest** here (the rest of the monorepo is vitest), aliasing
`@cpdevtools/git-flow-deploy` straight to the sibling package's source.

## License

MIT
