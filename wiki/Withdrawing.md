# Withdrawing a release

A release that must never be deployed again — a defective build, a vulnerable one, something
published by mistake, a service that has been retired — is **withdrawn**, not deleted. It keeps its
tag, its assets and its history, but `gitflow deploy` stops offering it, the deploy side refuses it,
and anyone looking at the release page sees why.

```sh
gitflow withdraw @org/orders@1.4.2
gitflow withdraw @org/orders@1.4.2 --kind broken --reason "double-charges discounted orders" --yes
gitflow withdraw @org/orders@1.5.0 --kind superseded --replaced-by 1.5.1
gitflow withdraw @org/legacy-service@all --kind obsolete --reason "service retired"
gitflow withdraw @org/orders@1.4.2 --undo
```

Like `gitflow deploy`, every flag that is not given is prompted for.

## What it does

1. **Marks the release.** A `withdrawn:` entry goes into the release body's `## Artifact Metadata`
   block — the block `gitflow deploy` already reads — the title gets a `[WITHDRAWN]` prefix, and a
   banner with the kind and reason goes above the notes. This happens first and never depends on
   anything after it.
2. **Dispatches `withdraw.yml`** in the repository for the parts that need registry credentials:
   - **Floating tags.** `latest`, `next` and the channel tag are recomputed without the withdrawn
     version and repointed to the next eligible one — `npm dist-tag add` for packages,
     `docker buildx imagetools create` (a server-side retag, nothing is pulled) for images. If no
     eligible version remains, the tag is removed rather than left on a withdrawn build.
     Publishing applies the same rule, so a later release never resurrects a withdrawn one.
   - **Registry effect**, as chosen: `mark` deprecates the npm version with a pointer to the release
     where the registry supports it — npmjs does, **GitHub Packages does not** (nor can NuGet or
     Docker registries mark a version), in which case the outcome is recorded as `unsupported` and
     the release marker is the record; `delete` removes the version from GitHub Packages (falling
     back to mark when that is refused); `none` leaves the registries alone.
   - **Assets**, as chosen: keep or delete the release's attached files.
     The outcome is written back into the marker (`registry: marked | deleted | unsupported`).

The workflow comes from the template repository as `withdraw.yml.example`; copy it to
`.github/workflows/withdraw.yml`. It needs `contents: write` and `packages: write`, both available
to `GITHUB_TOKEN`, plus whatever non-GitHub registry tokens `.publish/registries.yml` names.

## Kinds

| Kind         | Meaning                                                | Registry default | Assets default | Forceable |
| ------------ | ------------------------------------------------------ | ---------------- | -------------- | --------- |
| `broken`     | The build is defective                                 | mark             | keep           | no        |
| `security`   | A vulnerability in this version or a dependency        | mark             | keep           | no        |
| `accidental` | Released by mistake (wrong branch, premature merge)    | delete           | keep           | no        |
| `obsolete`   | No longer needed; nothing replaces it                  | none             | keep           | yes       |
| `superseded` | Replaced by a specific later version (`--replaced-by`) | none             | keep           | yes       |
| `temporary`  | A preview or throwaway build                           | none             | keep           | yes       |
| `legal`      | Must not be distributed                                | delete           | delete         | no        |

The defaults only pre-select the prompt. **Forceable** means the deploy side will still deploy it
with `deploy-gateway deploy --force` — for a rollback to a known-good but retired version. Kinds
where deploying is itself the harm can never be forced.

## Withdrawing a whole package

`<package>@all` marks every published release of the package. It refuses while the package is still
declared on the default branch — in a `release-artifacts.yml` artifact or as a project's
`package.json` name — because the next release PR would publish it again. Remove the artifact or
the project first.

## Seeing withdrawn releases

`gitflow deploy --include-withdrawn` lists them with their kind and reason, and warns before
dispatching one. On the deploy side, `deploy-gateway fetch` and `deploy-gateway deploy` refuse a
withdrawn release unless `--force` is given and the kind allows it; the gateway service always
refuses.

## Undo

`--undo` clears the marker, banner and title prefix, gives the version its floating tags back, and
clears an npm deprecation. Deleted registry versions and deleted assets are gone; the command says
so rather than pretending otherwise.
