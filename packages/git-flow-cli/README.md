# @cpdevtools/git-flow-cli

The `gitflow` CLI — the human entry point to the release pipeline. oclif-based.

Most of the pipeline runs itself: pushing keeps a draft release PR current, and merging that PR
builds, packs and publishes. This CLI covers the two things a person decides — **what version comes
next**, and **when to deploy** — plus the pack/stamp commands the GitHub Actions invoke.

## Install

```bash
pnpm add -D @cpdevtools/git-flow-cli
```

Then `pnpm gitflow <command>`, or add a `"gitflow": "gitflow"` script.

## Commands

### `gitflow version`

Interactively set a version key in `.publish/versions.yml` and commit the change.

Manifests all carry the placeholder `0.0.0-MAIN`; the real value lives in `versions.yml`, keyed per
branch. So a version branch like `v1.3` stays on the `1.3.x` track using the *same* `MAIN` key — what
differs is that the file is branch-specific.

The one hard rule: **it never offers an option that would collide with an already-released tag.**
Anything resolving to an existing tag is filtered out, so a shipped version cannot be re-picked. An
option whose directly-resulting version already exists stays visible but unselectable, rather than
vanishing without explanation.

### `gitflow deploy`

Interactively pick an environment, package and version, then dispatch that environment's deploy
workflow. Per-environment workflows are discovered by convention: `deploy-{env}.yml`.

- `latest` — the highest **stable** release (mainline only)
- `next` — the highest **overall**, including pre-releases (what a feature branch deploys)

Non-interactive:

```bash
gitflow deploy --target dev --package @org/app --version next --yes
```

### `gitflow pack`

Read `release-artifacts.yml`, run the per-type pack handlers, and write the `.artifact.yml`
descriptor. Usually invoked by a project's `github.actions.pack` script rather than by hand.

### `gitflow pack-deploy`

Convention-driven deploy-bundle builder: delegates to the registered `DeployMethodHandler` for the
artifact type, producing `deploy-<method>.zip` with its `deploy.yml` manifest. Extend by installing
a git-flow plugin whose manifest declares the method (`deployMethods` on a `GitFlowPlugin` export)
rather than by patching this command.

### `gitflow apply-version`

Stamp a resolved version into project files (`package.json`, `.csproj`), with optional configuration
hooks. Run by the build pipeline via `beforeTask`, which exports `PROJECT_VERSION` per project.

## Development

```bash
pnpm build   # tsup
pnpm test    # vitest
```

## License

MIT
