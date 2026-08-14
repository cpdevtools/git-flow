# Gotchas

Behaviour that is correct by design but easy to misread. Each entry says what happens, and what goes
wrong if you assume otherwise.

## A passing test run that ran no tests

`mode` selects **script names**, not behaviours. `test-optional` runs `github.actions.build` and
`github.actions.test`; a project defining neither is reported as _no-script_ and the run still goes
green.

A repository whose tests live under a plain `test` script therefore passes CI without ever running
them. Name the script `github.actions.test`, and check with `devutil discover` rather than assuming.

## A slashed branch can never publish a stable version

`v/1.8` is a development branch by definition, so it publishes only pre-releases. Nothing fails —
releases happen, they are just all pre-releases, which is easy to miss until someone asks why the
patch never shipped.

Maintenance lines must be `v1`, `v1.8`, `v2`. See [Branch Model](Branch-Model).

## The versions file is branch-specific

`.publish/versions.yml` is a normal file in the branch, so `main` and `v1.3` hold different content.
That is the mechanism behind maintenance lines — but it also means merging `main` into a maintenance
branch will try to bring `main`'s version with it. Resolve that conflict deliberately, in favour of
the maintenance branch's own value.

## Every `package.json` is a project

git-flow searches the whole repository for manifests, ignoring only `node_modules`, `.pnpm-prod`,
`.wireit`, `dist` and `.docker-bundle`, and skipping directories that own a `pnpm-workspace.yaml`.
It does **not** read the workspace member globs.

A fixture or example directory with a `package.json` will show up in the build set. Being discovered
does not mean being released, but it does mean being built.

## `versions-file` defaults to the old location

`create-release-pr`'s `versions-file` input defaults to `.github/versions.yml`. If your file is at
`.publish/versions.yml` — the documented location — you must pass it explicitly, or version
resolution fails to find any keys.

## Check out the merge commit, not the branch

`build-pack` and `publish-release` must run against
`${{ github.event.pull_request.merge_commit_sha }}`. Checking out the branch head gets a tree that
may not match the release that was reviewed.

## `auth` is a variable name, not a token

In `.publish/registries.yml`, `auth: GITHUB_TOKEN` names the environment variable to read at publish
time. Putting the token value there publishes your credentials to the repository.

## A `docker-image` name must not contain `/`

`name` is the bare repository name — `my-service`, not `ghcr.io/org/my-service`. Host and namespace
come from each registry entry and are composed per destination, so a full path in the name pins the
image to one registry and breaks as soon as a second is added.

## `docker-service` rejects `registries`

That type produces nothing to publish — its product is the deploy bundle. Declaring `registries` is
an error rather than a no-op, because silently ignoring it looks exactly like a publish that never
happened. Use `docker-image` if an image should be built and pushed.

## `nuget` does not control the version

The `nuget` type copies a `.nupkg` the build already produced; the package version is whatever the
build stamped, which may not be the release version. Use `dotnet-lib` for a library you own — it
owns both the pack and the version, so they always agree.

## `ng-lib` will not build for you

It verifies rather than builds. Generating and building the client belongs in
`github.actions.build`. Pack fails if the build output is missing, or if its version does not equal
the release version — a stale `dist` from a previous release would otherwise publish and then fail
verification at the very end of the run.

## A plugin must not import git-flow at runtime

Registries are module state in a bundled CJS build, and the copy a consuming repository resolves is
not the copy the action process dispatches from. A plugin that calls `registerArtifactType` itself
registers into a registry nobody reads, and **fails silently** — the type simply appears not to
exist. Export a manifest; use `import type` for the types. See [Plugins](Plugins).

## Two plugins supplying one type is a hard error

Not a silent pick. Name the one you want with `provider:` on the artifact.

## `versioning: major` is refused by default

A deploy method must declare `supportsParallelMajors`. Running two majors side by side requires the
handler to derive every shared identity — service name, published ports, volume names — from the
deployment slot. A handler that has not done that would collide with the major already deployed, so
the attempt is refused rather than made.

## `SupervisorPlan` is additive-only

During a self-update, the **outgoing** release's supervisor executes the plan written by the
**incoming** one. A newly required field therefore breaks upgrades from every version already
installed. New fields must always be optional.

## A deploy bundle carries no images

`deploy-<method>.zip` is orchestration only. Images always come from a registry, so a bundle is
useless without the registry credentials on the host.

## Merging publishes; it does not deploy

There is no deploy-on-merge. Publishing makes a version available; `gitflow deploy` decides that an
environment should run it. This is deliberate — see [Deployment](Deployment).

## `latest` is empty on a feature branch

`latest` resolves to the highest **stable** release, and a development branch cannot produce one.
Use `next`, which is the highest release including pre-releases.
