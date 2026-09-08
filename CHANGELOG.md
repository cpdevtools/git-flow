# Changelog

Reconstructed from tags, `chore: set MAIN → …` commits and commit subjects in `cpdevtools/git-flow`
(805 commits, 2026-01-16 → 2026-09-04). Every release cuts seven tags: `v<X>`, `MAIN/v<X>`, and one
per package.

Package set since 2026-07-09: `git-flow`, `git-flow-cli`, `git-flow-deploy`, `git-flow-deploy-cli`,
`git-flow-deploy-service`.

---

## 1.0.x — stable line (2026-08-14 → )

### 1.0.12 — 2026-09-04

- **Floating tags.** Publishing computes `latest` / `next` / `<channel>` pointers for mainline-shaped
  versions and pushes them as Docker tags and npm dist-tags; `floatingTags: false` opts out.
- `build-pack` reports permanent release URLs and the draft (`untagged-…`) URL side by side.
- ts-dev-utilities → 1.1.9.

### 1.0.11 — 2026-09-02

- `build-pack` packs and uploads a project that has `github.actions.pack` but **no build script**
  (what makes `docker-service` projects work end to end). Tests added.
- ts-dev-utilities → 1.1.8.

### 1.0.10 — 2026-09-01

- ts-dev-utilities → 1.1.7 (relay output mode in `devutil run --concurrency 1`).

### 1.0.9 — 2026-09-01

- `pnpm-workspace.yaml` `minimumReleaseAgeExclude`: removed version-pinned entries that shadowed the
  bare package name.
- ts-dev-utilities → 1.1.6.

### 1.0.8 — 2026-09-01

- ts-dev-utilities → 1.1.5.

### 1.0.7 — 2026-09-01

- **dev-link conversion of git-flow itself.** `.pnpmfile.cjs` deleted, `.publish/dev-local.yml`
  mapping added for the two ts-dev-utilities packages, `postinstall: devutil dev-link auto`, single
  committed root lockfile.

### 1.0.6 — 2026-08-31

- Actions **auto-detect the lockfile layout**: `pnpm install --lockfile-dir .pnpm-prod` when
  `.pnpm-prod/pnpm-lock.yaml` exists, else `pnpm install --frozen-lockfile`. File presence is the
  per-repo migration state, so consumer conversion to dev-link needs no coordination.
- ts-dev-utilities → 1.1.1.

### 1.0.5 — 2026-08-27

- `build-pack` reports **fail-fast cancellations** separately from failures.
- `verifyDepsBeforeRun` disabled in actions to stop redundant installs and races (08-26).

### 1.0.4 — 2026-08-26

- **`swarm-job` deploy method** for `docker-image` / `docker-service`: runs a one-shot swarm service and
  waits for job completion (`n/m complete` on failure / timeout).
- pnpm version pinned explicitly in action setup (08-24).

### 1.0.3 — 2026-08-21

- `findReleaseAssetId` for resolving a release asset by name.

### 1.0.2 — 2026-08-19

- **`cleanup-old-builds` rewritten in TypeScript.** The bash+jq original died on null `publishedAt`
  or a 404 object from the packages API. Now handles stale drafts, their tags, and the registry
  versions they published independently, with per-item error isolation.
- **New `cleanup-deleted-branch` action** and reusable workflow: deleting a work branch deletes its
  `release/<branch>` mirror.
- ghcr `BLOB_UNKNOWN` mid-push classified as transient so the existing retry handles it.
- Subprocess timeouts in `ng-lib` / `dotnet-lib` tests.
- ts-dev-utilities → 1.0.1.

### 1.0.1 — 2026-08-18

- **NuGet publish verification made real.** `isNugetPublished` had queried the service index
  unauthenticated (GitHub Packages 404s anonymous requests), so every dotnet-lib publish failed its
  post-publish verify. Rewritten against the NuGet v3 protocol with the registry token.
- **Resumable drafts.** `versionExists` no longer treats a partially published draft as a consumed
  version; only a finalised release (or a pre-flag legacy draft) consumes one, so a failed pack no
  longer bumps the next attempt to `.build.N`. Input validation on version resolution.

### 1.0.0 — 2026-08-14 (via 1.0.0-alpha.0, rc.0, rc.1 the same day)

First stable release. Everything from the 0.4.20 release-candidate run landed here:

- **Plugin system** (2026-08-13): manifest-driven plugins discovered by package name
  (`git-flow-plugin-*`) or `gitflow.plugin` key; built-ins registered through the same path;
  `provider:` disambiguation; `ProviderConflictError` on same-level ties; registry state on
  `globalThis` to survive tsup inlining.
- **Breaking rename `type: docker` → `type: docker-image`**, with `name` now the bare repository name
  (a `/` is rejected). New **`docker-service`** type (bundle-only, rejects `registries`).
- First-party **`dotnet-lib`** (owns build + pack + version) and **`ng-lib`** (verify-only) types.
- Deploy methods registered per artifact type; `supportsParallelMajors` capability gate for
  `versioning: major`.
- Health endpoint renamed **`/status`** (`{ ok, name, version }`) — breaking, forward-only (08-05;
  shipped 0.4.19 on 08-13).
- **Swarm service convergence** probe after `docker stack deploy` (0.4.20-rc.11); deploy record
  confirmation in `actions/deploy`.
- `normalizeSharedStorage`, `seedStorage`, storage migrations folder + ledger.
- Container-registry auth for private base images; Docker push retry on transient errors.
- `dev` channel retired from `CHANNEL_ORDER` (08-07) — channels are `alpha → beta → rc`.
- **Wiki** (16 pages) plus the **`publish-wiki`** action and reusable workflow.
- READMEs for all five packages; root README lists the branch model and versioning scheme, and warns
  that `mode` selects script names and that `SupervisorPlan` is additive-only.
- All consumers migrated to `docker-image` and `1.0.0-rc.0` the same day.

---

## 0.4.x — deploy system, contract hardening (2026-07-09 → 2026-08-14)

Notable versions: 0.4.15 / 0.4.16 (07-30), 0.4.17 (08-04), 0.4.18 (08-04, exports
`PROJECT_VERSION` to `github.actions.build`), 0.4.19 (08-13, `/status`), 0.4.20-alpha → rc.16
(08-05 → 08-14).

- **2026-07-09 — deploy system initialised**: packages `git-flow-deploy`, `git-flow-deploy-cli`,
  `git-flow-deploy-service` (NestJS) and `actions/deploy`; `gitflow deploy` and `gitflow pack-deploy`;
  HMAC-signed `POST /deploy`, chunked log streaming with `:hb` heartbeats and `EXIT:<n>`,
  idempotent on `release_id`.
- **2026-07-13**: `cleanup-old-builds` and `test-integration` composite actions.
- Deploy bundle became `deploy-<method>.zip` with a `deploy.yml` manifest; per-method `.deploy/<method>/`
  overrides; `@{ TOKEN }` template rendering; auto-derived asset names; `DEPLOY_HOST_ROOT`; image
  pinned via bundle `.env`; `--force-recreate` / `--remove-orphans` and a netns compose variant.
- **Supervisor** for self-replacing deploys (`SupervisorPlan`, bare or containerised launcher);
  `SelfRegistrationService`; initial-state recording; pm2 teardown = `stop` not `delete`.
- Per-run `deploy_env`, `allowed_methods` allowlist, "Show more versions" in the deploy prompt.
- Artifacts marked `published` in the release body as they upload.
- Tag format flipped to `{project}/v{version}` + `{group}/v{version}` (`7040acd`), freeing the bare
  `v{version}` tag and all `v*` aliases; `create-release-pr` warns on the self-comparing first run
  (`7a95d38`); `docker logout` in `finally` no longer breaks authenticated verification (`1c0f423`);
  build-pack works in non-git-flow repos (`2ac357d`).
- (In the gateway repo, not git-flow, but found by the same release run: the installer now picks the
  semver-highest **stable** release rather than GitHub's most-recently-created, and keeps or rotates
  existing secrets on re-run.)

---

## 0.3.x — parallel runner integration (2026-07-02 → 2026-07-07)

### 0.3.1 — 2026-07-03 (PR #85)

- **Phase D**: `build-pack` orchestrates through ts-dev-utilities' `runScripts` with `failFast`,
  `beforeTask` = apply version, `afterTask` = pack + upload. `executeBuild` removed.
- **Config migration** `.github/{versions,registries}.yml` → **`.publish/`**.
- **CLI split** into its own package (`packages/cli`, later `git-flow-cli`, bin `gitflow`); wireit
  orchestration; consistent `fix` / `format` / `check` / `clean` / `reset` scripts.
- Node 24; `actions/checkout@v7`, `setup-node@v6`, `pnpm/action-setup@v6` (reads `packageManager`).
- Dead code removed (`workspace-deps/docker.ts`); `console.warn` → `console.error` in execute paths.
- Husky pre-commit; `DEV_LOCAL` pnpmfile injection (later replaced by dev-link).
- `test` action rewritten as a thin adapter over the runner (superseding the never-built
  Phase 4 test-orchestration design).

---

## 0.1.x – 0.2.x — the original pipeline (2026-01-16 → 2026-02-25)

- **2026-01-16 — initial monorepo** and the `create-release-pr` action (Phase 1, complete 01-31):
  release branch lifecycle (create once, never force-update), draft PR with YAML metadata, close PR
  when branches are identical, versions file in JSON or YAML, triggers on every branch except
  `release/**`, CommonJS output, three-source version-existence checking.
- **2026-01-30 — `build-pack` and `publish-release` actions** (Phases 2 and 3, complete 01-31):
  artifact descriptors (`*.artifact.yml`), topological batching, draft releases with uploaded
  artifacts, resumability, registry-agnostic publishing to npm / NuGet / Docker with verification,
  workspace-dependency rewriting, explicit `prerelease` flag from PR metadata, Docker digest
  verification.
- **2026-02-04 — Phase 3.5**: version-group tags, restructured PR metadata, PR ↔ release
  cross-linking, tag preview in drafts, `DEFAULT` → `MAIN`, tags created before finalise. (The
  inverted `v{ver}/{pkg}` tag order introduced here was reverted in August.)
- **2026-02-05/06 — Phase 3.6**: `.build.*` versions publish only to GitHub Packages;
  reusable `cleanup-old-builds.yml` and daily `cleanup-scheduled.yml`; package-scope stripping for
  the Packages API.
- **2026-02-25**: `test` action (first version) and test/cleanup workflows.
