# Registries

`.publish/registries.yml` names the places artifacts can be published to. Artifacts refer to them by
ID, never by URL.

```yaml
registries:
  github-npm:
    type: npm
    url: https://npm.pkg.github.com
    auth: GITHUB_TOKEN
    scope: '@cpdevtools'

  ghcr:
    type: docker
    registry: ghcr.io
    namespace: cpdevtools
    auth: GITHUB_TOKEN
```

```yaml
# packages/api/release-artifacts.yml
artifacts:
  - type: npm
    name: '${PACKAGE_NAME}'
    registries:
      - github-npm # ← the ID above
```

The indirection is what lets one artifact publish to several destinations, and lets a destination
change — a new host, a different token — without touching any project.

## Registry types

Three types are supported. The set is deliberately closed: each type also drives the post-publish
verification, so adding one is more than adding an upload command.

### `npm`

| Field   | Required | Notes                                                  |
| ------- | -------- | ------------------------------------------------------ |
| `type`  | yes      | `npm`                                                  |
| `url`   | yes      | Registry URL                                           |
| `auth`  | yes      | **Name of the environment variable** holding the token |
| `scope` | no       | e.g. `@cpdevtools`                                     |

### `nuget`

| Field  | Required | Notes                                         |
| ------ | -------- | --------------------------------------------- |
| `type` | yes      | `nuget`                                       |
| `url`  | yes      | Registry URL                                  |
| `auth` | yes      | Environment variable name holding the API key |

### `docker`

| Field         | Required | Notes                                                                  |
| ------------- | -------- | ---------------------------------------------------------------------- |
| `type`        | yes      | `docker`                                                               |
| `registry`    | yes      | Registry host, e.g. `ghcr.io`                                          |
| `auth`        | yes      | Environment variable name holding the token                            |
| `namespace`   | no       | Organisation or user segment                                           |
| `usernameEnv` | no       | Environment variable holding the username, when the registry needs one |

A `docker-image` artifact's `name` is the bare repository name. The full reference is composed per
destination from that registry's `registry` and `namespace`, so the same image publishes to several
registries without the artifact knowing where they are.

## `auth` holds a variable name, not a token

```yaml
auth: GITHUB_TOKEN # correct — the name of the variable
```

Never a token value. The publisher reads `process.env[registry.auth]` at publish time and fails with
the expected variable name if it is unset. Whatever the workflow puts in the environment is what is
used, so credentials stay in GitHub secrets.

## Validation

The file is validated when it loads. Missing `registries`, a missing `type` or `auth`, an unknown
type, or a type-specific required field being absent all fail immediately with the registry's name —
before anything is published, rather than partway through.

Referring to an unknown registry ID from an artifact fails with the list of IDs that do exist.

## Verification

After publishing, each artifact is looked up at the released version, and the check is chosen by the
**registry** type rather than the artifact type. An artifact type that publishes through an npm or
NuGet registry therefore gets verification without needing to implement anything.
