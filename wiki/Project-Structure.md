# Project Structure

A project is one workspace member — one `package.json`. This page is the contract between a project
and the pipeline: what the project must provide, and what it gets in return.

The contract is deliberately small. git-flow decides **when** something runs and **what version** it
runs as; the project decides **how** it builds. There is no build system inside git-flow, and no
assumption that a project is even JavaScript — a `package.json` with scripts is the entry point, and
what those scripts do is the project's business.

## The minimum

```jsonc
// packages/api/package.json
{
  "name": "@org/api",
  "version": "0.0.0-MAIN", // the version key this project belongs to
  "scripts": {
    "github.actions.build": "tsup",
    "github.actions.test": "vitest run",
    "github.actions.pack": "gitflow pack",
  },
}
```

```yaml
# packages/api/release-artifacts.yml
artifacts:
  - type: npm
    name: '${PACKAGE_NAME}'
    registries:
      - github-npm
```

That is a complete releasable project.

## The version placeholder selects the version key

`"version": "0.0.0-MAIN"` is not a version — it is the project's declaration of which
[version key](Versioning) it belongs to. Every project sharing a key releases together, under one
number, resolved from `.publish/versions.yml`.

Change the placeholder to move a project onto a different key. Nothing else needs updating.

## The scripts

Script names are the interface. git-flow runs them by name and never inspects what is inside them.

| Script                                | When it runs                                       | Purpose                                          |
| ------------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| `github.actions.build`                | on every push (test workflow) and during a release | Build the project                                |
| `github.actions.test`                 | on every push                                      | Run its tests                                    |
| `github.actions.pack`                 | during a release, after a successful build         | Produce the declared artifacts                   |
| `github.actions.pack-deploy-<method>` | during a release, for deployable artifacts         | Optional; build the deploy bundle for one method |

> **A project that defines none of the target scripts is reported as _no-script_ and the run still
> passes.** This is by design — most workspaces contain projects with nothing to test. It also means
> a project whose tests live under a plain `test` script will pass CI without ever running them.
> Name the script `github.actions.test`. See [Gotchas](Gotchas).

For most projects `github.actions.pack` is exactly `gitflow pack`, which reads
`release-artifacts.yml` and dispatches each declared artifact to its type handler. Write something
else only when a project produces something no artifact type covers.

### Opting in and out

| The project has                                       | Result                                  |
| ----------------------------------------------------- | --------------------------------------- |
| no `github.actions.*` scripts                         | Discovered, never built, never released |
| `github.actions.build` / `.test` only                 | Built and tested; not released          |
| `github.actions.pack` **and** `release-artifacts.yml` | Released                                |

A project with no artifacts is still built when something that _is_ being released depends on it —
it appears in the plan as `build-only`.

## What the scripts receive

Every script runs with the ordinary environment plus:

| Variable                          | Available in             | Value                                     |
| --------------------------------- | ------------------------ | ----------------------------------------- |
| `PROJECT_NAME`                    | all                      | The project's `package.json` name         |
| `PROJECT_CWD`                     | all                      | Absolute path to the project directory    |
| `PROJECT_VERSION`                 | build, pack, pack-deploy | **The resolved release version**          |
| `ARTIFACT_OUTPUT_DIR`             | build, pack, pack-deploy | Where produced artifacts must be written  |
| `DEPLOY_OUTPUT_DIR`               | pack-deploy              | Where the deploy bundle must be assembled |
| `ARTIFACT_TYPE`                   | pack-deploy              | The artifact type being packed            |
| `GITHUB_RELEASE_ID`               | pack-deploy              | Numeric ID of the draft release           |
| `GITHUB_SHA`, `GITHUB_REPOSITORY` | all                      | Standard GitHub context                   |

`PROJECT_VERSION` is how a build stamps itself:

```jsonc
"github.actions.build": "docker build -t my-service:${PROJECT_VERSION} ."
```

Before the build runs, git-flow has also written the resolved version into the project's manifests,
so tools that read `package.json` see the real version rather than the placeholder. That edit is
never committed.

## `release-artifacts.yml`

Declares what the project publishes. It is read at pack time; each entry is dispatched to the
handler for its `type`.

```yaml
artifacts:
  - type: npm
    name: '${PACKAGE_NAME}'
    registries:
      - github-npm

  - type: docker-image
    name: my-service
    registries:
      - ghcr
    deploy:
      - swarm
```

`${PACKAGE_NAME}`, `${PACKAGE_VERSION}`, `${PROJECT_NAME}` and `${ARTIFACT_OUTPUT_DIR}` are
substituted into `name` and `path`. `.yaml`, `.json`, `.ts`, `.js` and `.cjs` are also accepted; a
`.ts`/`.js` file default-exports the same shape.

The file is **declarative**. No key in it is executed as a command — building is the build script's
job. See [Artifacts](Artifacts) for every type and field.

## `.deploy/` — deployable projects

An artifact that declares `deploy:` produces one bundle per method, and each is built by the first
of these that exists:

1. **`.deploy/<method>/`** — a directory in the project. Its contents are copied into the bundle
   verbatim. If it contains no `deploy.yml`, one is generated for it.
2. **`github.actions.pack-deploy-<method>`** — a script, run with `DEPLOY_OUTPUT_DIR` set.
3. **The registered handler** for that artifact type and method — `compose` and `swarm` ship with
   git-flow.

The ordering is "most local wins": a project that needs a custom stack file drops it in
`.deploy/swarm/` and still gets a generated manifest, without having to reimplement the method.

```
packages/api/
└── .deploy/
    └── swarm/
        └── stack.yml
```

Files in the bundle are rendered with the deploy tokens — `{{SERVICE}}`, `{{STACK}}`,
`{{VERSION}}`, `{{MAJOR}}` and others — so identity values can appear in YAML keys where runtime
environment interpolation cannot reach. See [Deployment](Deployment).

## A worked set

```
packages/
├── lib-core/              built, tested, not released
│   └── package.json           github.actions.build, github.actions.test
├── api/                   released as an npm package
│   ├── package.json           + github.actions.pack
│   └── release-artifacts.yml  type: npm
└── service/               released as an image, deployed to swarm
    ├── package.json           github.actions.build → docker build
    ├── release-artifacts.yml  type: docker-image, deploy: [swarm]
    └── .deploy/swarm/stack.yml
```

If `api` depends on `lib-core`, releasing `api` builds `lib-core` first and publishes nothing for
it.
