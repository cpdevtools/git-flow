# Phase 4 Implementation - COMPLETE ✅

**Implementation Date**: July 2, 2026  
**Status**: All components implemented, published, and CI passing

## 📦 What Was Built

### 1. Dependency-Driven Parallel Test Runner (`@cpdevtools/ts-dev-utilities`)

A generic parallel script runner that orders execution by the workspace dependency graph — projects start as soon as all their workspace dependencies have passed, not in fixed waves.

**Published**: `@cpdevtools/ts-dev-utilities@0.2.5`

Key API (`ts-dev-utilities/runner`):

- **`runScripts(options)`** — Discover all workspace projects, build a dependency graph, and run one or more named scripts in topological order with configurable concurrency
- **`RunSummary`** — Typed result with `passed`, `failed`, `skipped`, `cancelled` task lists and per-task output/truncation metadata
- Task outcomes: `passed`, `failed`, `skipped` (dependency failed), `cancelled` (fail-fast triggered), `no-script` (project doesn't define the script — treated as a pass)

### 2. `Test Projects` GitHub Action (`actions/test/`)

GitHub Action wrapping the parallel runner for use in CI.

- **[action.yml](actions/test/action.yml)** — Composite action definition
  - Inputs: `mode` (`build` | `test` | `test-optional`), `fail-fast`, `concurrency`, `token`, `workspace-root`
  - Outputs: `projects-passed`, `projects-failed`, `projects-skipped`

- **[src/action.ts](actions/test/src/action.ts)**
  - Maps `mode` → script list (`github.actions.build`, `github.actions.test`)
  - Calls `runScripts()` with all inputs
  - Renders GitHub Annotations (one `core.error` per failed project)
  - Renders a Step Summary table (Passed / Failed / Skipped / Cancelled counts + project names)
  - Sets `core.setFailed` if any project failed

### 3. Production Lockfile Strategy (`.pnpm-prod/`)

Ensures CI always installs from published registry versions, never from `file:` workspace paths used during local development.

- **[.pnpm-prod/pnpm-lock.yaml](.pnpm-prod/pnpm-lock.yaml)** — Lockfile generated with `DEV_LOCAL=false`, containing only published package versions
- **[.husky/pre-commit](.husky/pre-commit)** — Auto-regenerates `.pnpm-prod/pnpm-lock.yaml` before every commit via `pnpm install --lockfile-dir .pnpm-prod --lockfile-only --config.minimumReleaseAge=0`
- **[.gitignore](.gitignore)** — Excludes `.pnpm-prod/*` except the lockfile
- **[.pnpmfile.cjs](.pnpmfile.cjs)** — Overrides `@cpdevtools/ts-dev-utilities` to `file:../ts-dev-utilities` only when `DEV_LOCAL=true` (local dev); CI uses published version

### 4. Node 24 + pnpm 11 Upgrade (All Actions)

All four composite actions updated to the current toolchain:

| Action                      | Changes                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `actions/test`              | Node 24, pnpm 11, registry auth step, `--lockfile-dir .pnpm-prod`, `HUSKY=0` |
| `actions/build-pack`        | Same                                                                         |
| `actions/create-release-pr` | Same                                                                         |
| `actions/publish-release`   | Same                                                                         |

### 5. globby / Node 24 CJS Compatibility Fix

`globby@14` is ESM-only; `unicorn-magic` (its dep) lacks `require`/`module-sync` exports conditions, causing `ERR_PACKAGE_PATH_NOT_EXPORTED` when loaded from a Node 24 CJS context.

**Fix**: Added `noExternal: ['globby']` to `tsup.config.ts` in `ts-dev-utilities`, causing esbuild to inline globby and all its transitive dependencies into the CJS bundle. The bundled output never `require('globby')` at runtime — globby's code is self-contained in the dist.

## 🔧 Infrastructure Changes

- `packages: read` permission added to `.github/workflows/test.yml`
- `pnpm config set "//npm.pkg.github.com/:_authToken"` step added to all actions (pnpm 11 ignores project-level `.npmrc` auth for security)
- `prepare: "husky || true"` — prevents failure when husky is absent in `--prod` installs
- `engines: { node: ">=24" }` in `packages/git-flow/package.json`
- CLI binary renamed from `cpdt-gitflow` → `gitflow`

## ✅ Verification

CI on commit `4091a28` (July 2, 2026):

- **Test** workflow: ✅ success
- **Create Release PR** workflow: ✅ success
