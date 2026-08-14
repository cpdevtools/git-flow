# Publish Wiki Action

Mirrors a directory in the repository into the repository's GitHub wiki, so wiki pages are
authored and reviewed alongside the code they document.

A GitHub wiki is a separate git repository (`<owner>/<repo>.wiki.git`) with no pull requests, no
branch protection and no CI. Keeping the pages in the code repo and publishing them from here means
a change to an API and the change to the page describing it land in the same review.

The sync is a **mirror**: pages deleted from the source directory are deleted from the wiki. The
wiki is therefore a rendered output, not a second place to edit — anything written in the wiki UI is
overwritten by the next run.

## Usage

```yaml
name: Publish Wiki

on:
  push:
    branches: [main]
    paths: ['wiki/**']

jobs:
  publish-wiki:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: cpdevtools/git-flow/actions/publish-wiki@main
        with:
          source: wiki
          token: ${{ secrets.GITHUB_TOKEN }}
```

A reusable workflow wrapper is also available for repositories that prefer to call it as a job:

```yaml
jobs:
  publish-wiki:
    uses: cpdevtools/git-flow/.github/workflows/publish-wiki.yml@main
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
```

To publish generated pages, do the generation first and turn off the action's own checkout:

```yaml
- uses: actions/checkout@v7
- run: pnpm docs:build # writes ./wiki
- uses: cpdevtools/git-flow/actions/publish-wiki@main
  with:
    checkout: 'false'
```

## Inputs

| Input        | Default                     | Description                                                                        |
| ------------ | --------------------------- | ---------------------------------------------------------------------------------- |
| `source`     | `wiki`                      | Directory holding the pages, relative to the workspace root.                        |
| `repository` | `${{ github.repository }}`  | Repository whose wiki to publish to, as `owner/repo`.                              |
| `message`    | `docs: sync wiki from <sha>` | Commit message for the wiki commit.                                                |
| `checkout`   | `true`                      | Check out the repository first. Set `false` when a previous step generated `source`. |
| `dry-run`    | `false`                     | Print the changes without pushing.                                                  |
| `token`      | `${{ github.token }}`       | Needs `contents: write`.                                                            |

## Outputs

| Output    | Description                                                    |
| --------- | -------------------------------------------------------------- |
| `changed` | `true` when the wiki was updated, `false` when already in sync. |
| `pages`   | Number of markdown pages in the source directory.               |

## Page layout

Filenames become page titles, with dashes rendered as spaces — `Getting-Started.md` publishes as
*Getting Started*. Two names are special: `_Sidebar.md` renders as the navigation panel on every
page and `_Footer.md` as the footer. Everything else in the directory is copied as-is, so images
and other assets can sit alongside the pages.

Link between pages by filename without the extension: `[Getting Started](Getting-Started)`. Relative
links to files in the code repository do **not** resolve from the wiki — use full URLs for those.

## Requirements

The job needs `contents: write`, which is what grants push access to the wiki.

**The wiki must already exist.** GitHub does not create the wiki repository until its first page is
saved, and an uninitialised wiki reports as *not found* rather than as empty — so the first page has
to be created once by hand at `https://github.com/<owner>/<repo>/wiki/_new`. The action detects this
case and says so rather than failing with a bare clone error.

## Safety

- An empty or missing source directory **fails the run** instead of mirroring as "delete every
  page".
- The token is passed as an HTTP header rather than embedded in the remote URL, so it is never
  written into the clone's `.git/config`, and its base64 form is masked in the log.
- A `.git` directory inside the source is excluded, so it cannot overwrite the wiki's own.
- When nothing differs, the run exits without creating an empty commit.
