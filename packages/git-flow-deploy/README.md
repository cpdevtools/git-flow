# @cpdevtools/git-flow-deploy

Framework-free core of the deploy gateway. No HTTP server, no CLI, no DI container — just the rules,
so that every host implementing the deploy contract answers identically.

Consumed by [`git-flow-deploy-cli`](../git-flow-deploy-cli),
[`git-flow-deploy-service`](../git-flow-deploy-service), and by client gateways that are not written
in TypeScript (which reach it through the CLI rather than by importing it).

> **Why this package exists.** Every rule here is one that would otherwise be reimplemented per host,
> and reimplementations drift. That is not hypothetical: a client gateway once reimplemented glob
> matching in C# and got a **fail-open** bug, because that library had no brace support — so `{a,b}`
> matched nothing, which is harmless in an allow list and silently disables a deny rule. Signature
> verification, repo rules, slot naming, and manifest parsing all live here for the same reason.

## Install

```bash
pnpm add @cpdevtools/git-flow-deploy
```

## Exports

### Signing

```ts
import { signRequest, validateHmac, validateTimestamp,
         SIGNATURE_HEADER, TIMESTAMP_HEADER, DEFAULT_TIMESTAMP_WINDOW_SECONDS } from '@cpdevtools/git-flow-deploy';
```

HMAC-SHA256 over `"<timestamp>.<rawBody>"` — the timestamp is inside the signed payload, so a
captured request cannot be replayed outside its window (±60 s by default). Verify against the **raw**
body bytes; re-serializing JSON changes them.

### Manifest

```ts
import { parseDeployYml, type DeployManifest, type SharedStorageSpec } from '@cpdevtools/git-flow-deploy';
```

Required: `name`, `version`, `repo`, `releaseId` (positive int), `deployCommand`.
Optional: `stack`, `service`, `swarmService`, `method` (`node|compose|swarm`), `slot`,
`versioning` (`singleton|major`), `teardownCommand`, `sharedStorage`, `seedStorage`.

### Bundle and execution

```ts
import { fetchDeployBundle, runDeploy } from '@cpdevtools/git-flow-deploy';
```

`fetchDeployBundle` downloads a named release asset and extracts it; `runDeploy` executes the
manifest's `deployCommand`, streaming output line by line and resolving to an exit code.

### Storage

```ts
import { prepareSharedStorage, declaresSharedStorage, sharedStorageDir,
         sharedBucketDir, versionedBucketDir,
         prepareSeedStorage, declaresSeedStorage, prepareStorageMigrations } from '@cpdevtools/git-flow-deploy';
```

Two layouts. Flat legacy `{base}/{service}/`, and stacked
`{base}/{stack}/{service}/{shared|v<major>}/` — the presence of `stack` is what switches modes.
`shared/` survives major upgrades; `v<major>/` does not, which is the point.

All `sharedStorage` entries must be relative and free of `..`. `seedStorage` is **seed-if-missing**,
so operator edits survive a redeploy. `prepareStorageMigrations` copies (never moves) from a legacy
path, one-shot, and only while the target is still empty — so an older major still running keeps
reading the old location.

### Slots

```ts
import { safeName, majorVersion, deploymentSlot, slotStack, type VersioningStrategy } from '@cpdevtools/git-flow-deploy';
```

`safeName` is load-bearing: a scoped package like `@org/svc` must resolve to the same string
everywhere, or the directory a bundle mounts will not be the directory the gateway created.

### Swarm rollout

```ts
import { stackRollout, serviceRollout, serviceReplicas, waitForSwarmConvergence,
         rolloutStateOf, aggregateRollout, type SwarmRolloutState } from '@cpdevtools/git-flow-deploy';
```

`docker stack deploy` returns before the rollout starts and cannot report its outcome, so success has
to be observed separately.

> **`converged` is not success.** It says the rollout finished, not that it installed what you asked
> for. Only the running version proves that. Treat `rolled-back` as a definite failure, `converged`
> and everything else as *not yet a decision*.

### Repo rules

```ts
import { isRepoAllowed, readReposConfig, writeReposConfig, reposConfigPath,
         DEFAULT_REPOS_CONFIG_PATH, EMPTY_REPOS_CONFIG, type ReposConfig } from '@cpdevtools/git-flow-deploy';
```

`{ allow: string[], deny: string[] }`, minimatch semantics, deny wins. An **absent config reads as
empty, which permits everything** — so seed a `repos.json` on first install rather than relying on a
default.

## Development

```bash
pnpm build   # tsup
pnpm test    # vitest
```

Every module has a colocated `*.test.ts`.

## License

MIT
