# CLI

`gitflow`, from `@cpdevtools/git-flow-cli`. Two of its commands are for you (`version`, `deploy`);
the rest are what projects and the pipeline call.

```bash
pnpm add -D @cpdevtools/git-flow-cli
pnpm gitflow --help
```

`GITHUB_TOKEN` must be set for anything that talks to GitHub.

| Command                        | Who runs it                                 |
| ------------------------------ | ------------------------------------------- |
| `gitflow version`              | you, to set a release version               |
| `gitflow deploy`               | you, to deploy a release                    |
| `gitflow pack`                 | the project, from `github.actions.pack`     |
| `gitflow pack-deploy <method>` | the project, when building a bundle by hand |
| `gitflow apply-version`        | the pipeline                                |

---

## `gitflow version`

Interactively set a version key in `.publish/versions.yml` and commit the change.

```bash
gitflow version
gitflow version --key MAIN
gitflow version --key MAIN --no-commit
```

| Flag           | Meaning                                  |
| -------------- | ---------------------------------------- |
| `--key <NAME>` | Choose the version key without prompting |
| `--no-commit`  | Write the file, leave the commit to you  |

It offers only legal next versions and will not offer one that collides with an existing tag. See
[Versioning](Versioning).

---

## `gitflow deploy`

Resolve the current branch to its release branch, choose an environment and a release, and dispatch
that environment's deploy workflow.

```bash
gitflow deploy
gitflow deploy --target production --package @org/api --version latest --yes
gitflow deploy --repo owner/repo --branch release/main --target dev --yes
```

| Flag                      | Meaning                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `-r, --repo <owner/repo>` | Defaults to the current `origin` remote                                |
| `-b, --branch <branch>`   | Release branch to scan. Defaults to `release/<current-branch>`         |
| `-t, --target <env>`      | Environment. Skips the prompt                                          |
| `-p, --package <name>`    | Package to deploy. Repeatable                                          |
| `-v, --version <spec>`    | A semver string, `latest` (highest stable) or `next` (highest overall) |
| `-m, --method <name>`     | Deploy method. Must be one the release advertises                      |
| `-s, --set KEY=VAL`       | Per-run environment override. Repeatable                               |
| `-e, --env-file <path>`   | File of `KEY=VAL` lines. Repeatable; later files win                   |
| `-y, --yes`               | Skip the confirmation prompt                                           |

With every prompt-skipping flag supplied it is fully non-interactive, which is what makes it usable
from a script. See [Deployment](Deployment).

---

## `gitflow pack`

Read `release-artifacts.yml`, run each artifact's pack handler, and write the `.artifact.yml`
descriptor.

```jsonc
"scripts": {
  "github.actions.pack": "gitflow pack"
}
```

It reads `PROJECT_NAME`, `PROJECT_VERSION` and `ARTIFACT_OUTPUT_DIR` from the environment, which the
pipeline sets. Both can be passed explicitly for a local run:

```bash
gitflow pack --project-name @org/api --version 1.0.0
```

---

## `gitflow pack-deploy <method>`

Build the deploy bundle for one method by delegating to the registered handler for the artifact
type.

```bash
gitflow pack-deploy swarm
```

Most projects never call this — the pipeline builds bundles for every method listed under an
artifact's `deploy:` key. Use it when a project needs to assemble a bundle itself, from a
`github.actions.pack-deploy-<method>` script.

---

## `gitflow apply-version`

Write a real version into the project's manifests (`package.json`, `.csproj`), replacing the
placeholder.

```bash
gitflow apply-version 1.2.3
PROJECT_VERSION=1.2.3 gitflow apply-version
```

The pipeline runs this before each project's build. The edit is not committed — the placeholder is
what stays in the repository. See [Versioning](Versioning).
