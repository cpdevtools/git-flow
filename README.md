# git-flow

Release-automation toolkit for pnpm/TypeScript (and .NET) monorepos. It takes a branch from commit →
versioned build → published packages → live deployment, driven by GitHub Actions and a `gitflow` CLI.

The system is **event-driven**: pushing to any branch keeps a draft **release PR** up to date;
**merging** that PR is what builds, packs and publishes; **deploy** is a separate, CLI-initiated
step. Tests run continuously on every commit, independent of the release line.

## Branch model

- Every branch has a corresponding **`release/`** branch.
- Branches **without** a `/` are mainline (stable). Branches **with** a `/` are development.

LTS lines are therefore `v1`, `v2`, … — not `v/1`. The no-slash form is required, not cosmetic: a
slashed branch is treated as a development line and can never publish a stable patch.

## Versioning

Every manifest carries the placeholder `0.0.0-MAIN`. Real versions live in `.publish/versions.yml`,
which is branch-specific — so `v1.3` and `main` share the same `MAIN` key while resolving to
different tracks. Release tags are `{project}/v{version}` plus `{group}/v{version}`.

## Packages

| Package                                                                     | Purpose                                                                                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`@cpdevtools/git-flow`](./packages/git-flow)                               | Core library — version resolution, branch ops, build/pack orchestration, publishing, artifact registry      |
| [`@cpdevtools/git-flow-cli`](./packages/git-flow-cli)                       | The `gitflow` CLI — `version`, `deploy`, `pack`, `pack-deploy`, `apply-version`                             |
| [`@cpdevtools/git-flow-deploy`](./packages/git-flow-deploy)                 | Framework-free deploy core — manifest, HMAC, bundle fetch, shared storage, slots, swarm rollout, repo rules |
| [`@cpdevtools/git-flow-deploy-cli`](./packages/git-flow-deploy-cli)         | Server-side `deploy-gateway` CLI, run on the deploy host                                                    |
| [`@cpdevtools/git-flow-deploy-service`](./packages/git-flow-deploy-service) | Reference deploy gateway (NestJS) — also published as a Docker image                                        |

## Actions

| Action                                               | Purpose                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| [`test`](./actions/test)                             | Runs build/test scripts across workspace projects in dependency order |
| [`test-integration`](./actions/test-integration)     | The same, for integration scripts, on PRs                             |
| [`create-release-pr`](./actions/create-release-pr)   | Creates/updates the release PR with resolved version metadata         |
| [`build-pack`](./actions/build-pack)                 | Builds and packs release artifacts from a release PR                  |
| [`publish-release`](./actions/publish-release)       | Publishes to registries and finalises releases                        |
| [`deploy`](./actions/deploy)                         | Sends a signed deploy request to a gateway and streams the log back   |
| [`cleanup-old-builds`](./actions/cleanup-old-builds) | Prunes superseded prerelease builds                                   |

### `test` inputs

| Input            | Default                   | Description                                                |
| ---------------- | ------------------------- | ---------------------------------------------------------- |
| `mode`           | `test-optional`           | `build`, `test`, or `test-optional` (both where available) |
| `fail-fast`      | `false`                   | Stop on first failure, cancel in-flight tasks              |
| `concurrency`    | _(unlimited)_             | Max projects to run in parallel                            |
| `workspace-root` | `${{ github.workspace }}` | Workspace root                                             |

**Outputs:** `projects-passed`, `projects-failed`, `projects-skipped`

> `mode` selects **script names**, not behaviours: `test-optional` runs `github.actions.build` and
> `github.actions.test`. A project defining neither is reported as _no-script_ and the run still goes
> green — so a repo whose tests live under a plain `test` script will pass CI without ever testing
> anything. Name the script `github.actions.test`.

## Workflows

- [`create-release-pr.yml`](./.github/workflows/create-release-pr.yml) — on push to any non-`release/**` branch
- [`test.yml`](./.github/workflows/test.yml) — on every push
- [`build-pack-publish.yml`](./.github/workflows/build-pack-publish.yml) — on a PR merged into `release/**`
- [`cleanup-scheduled.yml`](./.github/workflows/cleanup-scheduled.yml) — daily

## Consuming this from a project

1. Add the git-flow devDependencies and set every manifest `version` to `0.0.0-MAIN`.
2. Add `.publish/versions.yml`, `.publish/registries.yml`, `.publish/deps.yml`.
3. Implement the standard scripts your project needs — `github.actions.build`, `github.actions.test`,
   `github.actions.pack`. The workflows define the names and pass env vars; how each project
   satisfies them is its own business.
4. Add `release-artifacts.yml` per publishable project.
5. For deployable projects, add `.deploy/<method>/` and a per-environment `deploy-{env}.yml`.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm format
```

Set `DEV_LOCAL=true` to resolve `@cpdevtools/ts-dev-utilities` and `@cpdevtools/git-flow` from
sibling checkouts instead of the registry.

## License

MIT
