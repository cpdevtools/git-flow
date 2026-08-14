# Artifacts

An artifact is one thing a project publishes. A project declares its artifacts in
`release-artifacts.yml`; git-flow dispatches each one to the handler registered for its `type`.

```yaml
artifacts:
  - type: npm
    name: '${PACKAGE_NAME}'
    registries:
      - github-npm
```

The file is declarative — nothing in it is executed as a command. Building is the project's
`github.actions.build` script; artifact handlers package what that build produced.

## Built-in types

| Type                 | Produces                                                   | Publishes to      |
| -------------------- | ---------------------------------------------------------- | ----------------- |
| `npm`                | A `.tgz` from the project directory                        | npm registries    |
| `nuget`              | Copies an existing `.nupkg`                                | NuGet registries  |
| `dotnet-lib`         | Runs `dotnet build` + `dotnet pack` at the release version | NuGet registries  |
| `ng-lib`             | Packs an npm package built outside the project directory   | npm registries    |
| `docker-image`       | Builds, saves and pushes one image                         | Docker registries |
| `docker-service`     | Nothing — the product is the deploy bundle                 | —                 |
| `release-attachment` | Attaches an arbitrary file to the GitHub Release           | —                 |
| `deploy`             | A deploy bundle zip                                        | —                 |

### `npm`

| Field        | Notes                                        |
| ------------ | -------------------------------------------- |
| `name`       | Package name. Usually `'${PACKAGE_NAME}'`.   |
| `path`       | Filled in by pack — omit it.                 |
| `registries` | Registry IDs from `.publish/registries.yml`. |

### `nuget`

Copies a `.nupkg` the build already produced — typically via `GeneratePackageOnBuild`. It does not
pack, and does not control the version, so the package version is whatever the build stamped.

| Field        | Notes                                                   |
| ------------ | ------------------------------------------------------- |
| `name`       | Package id                                              |
| `path`       | Path to the `.nupkg`, relative to the project directory |
| `registries` | Registry IDs                                            |

### `dotnet-lib`

Owns both the pack and the version, so the package version always matches the release. It builds
with `-p:Version` and `-p:PackageVersion` set to the release version, then packs `--no-build`.

| Field           | Notes                                                                          |
| --------------- | ------------------------------------------------------------------------------ |
| `name`          | NuGet package id. Must match the csproj `PackageId`.                           |
| `project`       | csproj path relative to the project directory. Defaults to the only one found. |
| `configuration` | Defaults to `Release`.                                                         |
| `registries`    | Registry IDs                                                                   |

Prefer this over `nuget` for a library you own. Use `nuget` only when something else must control
the packaging.

### `ng-lib`

For an npm package generated _outside_ the project directory — a generated API client, say — and
published from its own build output.

| Field        | Notes                                                      |
| ------------ | ---------------------------------------------------------- |
| `name`       | Package name, as published                                 |
| `directory`  | Where the package lives, relative to the project directory |
| `packDir`    | Subdirectory the build emits. Defaults to `dist`.          |
| `registries` | Registry IDs                                               |

It **verifies rather than builds**. Generating and building the client belongs in the project's
`github.actions.build`. Pack fails if the build output is missing, or if its `package.json` version
does not equal the release version — a stale `dist` left over from a previous release would
otherwise publish successfully and then fail verification.

### `docker-image`

| Field        | Notes                                                                     |
| ------------ | ------------------------------------------------------------------------- |
| `name`       | **The bare repository name** — `my-service`, not `ghcr.io/org/my-service` |
| `localTag`   | Local tag to push. Defaults to `name:latest`.                             |
| `registries` | Registry IDs                                                              |
| `deploy`     | Deploy methods to build bundles for                                       |

> **`name` must not contain a `/`.** Host and namespace come from each registry entry and are
> composed per destination, so one image can publish to several registries. Baking a full path into
> the name pins it to one host, which stops making sense the moment a second registry is added.

The image itself is built by the project's `github.actions.build`, usually stamping
`${PROJECT_VERSION}` as a tag.

### `docker-service`

`docker-image` without the image: for third-party infrastructure — traefik, mysql, grafana — where
the repository's entire product is the deploy bundle. Nothing is packed, uploaded or published.

| Field    | Notes                                                               |
| -------- | ------------------------------------------------------------------- |
| `name`   | Service name. Defaults to the project name.                         |
| `deploy` | Deploy methods, same `compose` / `swarm` handlers as `docker-image` |

Declaring `registries` on this type is an error rather than a no-op, because a silently ignored
`registries` looks exactly like a publish that never happened.

### `release-attachment`

| Field         | Notes                                  |
| ------------- | -------------------------------------- |
| `name`        | Display name                           |
| `path`        | Path relative to the project directory |
| `contentType` | e.g. `application/octet-stream`        |

### `deploy`

A standalone deploy bundle, for a project whose only output is deployment instructions. Most
projects get bundles through `deploy:` on another artifact instead.

## Deployment keys

Any artifact may carry these. They configure the bundle, not the artifact.

| Key             | Default                   | Meaning                                                                                |
| --------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| `deploy`        | —                         | List of methods to build bundles for, e.g. `[swarm]`                                   |
| `versioning`    | `singleton`               | `singleton` replaces the running instance; `major` runs one instance per major version |
| `stack`         | the package scope         | Shared stack this service deploys into                                                 |
| `service`       | the unscoped package name | Service token used in generated names and storage paths                                |
| `sharedStorage` | —                         | Directories that persist across deployments                                            |
| `seedStorage`   | —                         | Directories populated once, if missing                                                 |

`versioning: major` is refused unless the deploy method declares that it supports parallel majors —
running two majors side by side requires the handler to derive every shared identity (service names,
published ports, volume names) from the deployment slot. See [Deployment](Deployment).

## Substitution

`${…}` placeholders in `name` and `path` are replaced at pack time:

| Placeholder              | Value                                              |
| ------------------------ | -------------------------------------------------- |
| `${PACKAGE_NAME}`        | The project's `package.json` name, e.g. `@org/api` |
| `${PACKAGE_VERSION}`     | The resolved release version                       |
| `${PROJECT_NAME}`        | The name with `@` and `/` removed, e.g. `org-api`  |
| `${ARTIFACT_OUTPUT_DIR}` | Directory artifacts are written to                 |

## Choosing a handler when two supply the same type

If an installed plugin and another source both provide the same type name, the artifact names the
one it wants:

```yaml
artifacts:
  - type: helm-chart
    provider: '@org/git-flow-plugin-helm'
```

Precedence, most local first: `provider:` on the artifact, then plugins declared by the project,
then plugins declared at the workspace root, then git-flow's built-ins. A tie within a level is a
hard error naming both packages. See [Plugins](Plugins).

## What pack writes

After the handlers run, git-flow writes `<project>.artifact.yml` — the same declarations with the
produced paths, tags and digests filled in — and uploads it to the draft release alongside the
artifacts. `publish-release` reads it back. Its presence is also what marks a project complete, so a
re-run skips it.
