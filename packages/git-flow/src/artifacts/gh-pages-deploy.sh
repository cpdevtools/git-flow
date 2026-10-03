#!/bin/sh
# Publish a static-site deploy bundle to the repo's gh-pages branch.
#
# Usage: sh ./gh-pages-deploy.sh <slot-path> <name> <version>
#   slot-path  where the site lands under the environment prefix
#              ('org-site', 'org-site/v2', or '' for the Pages root)
#
# Run from the extracted bundle directory (site/ is next to this script).
#
# Environment (all optional except the two GitHub ones):
#   GITHUB_REPOSITORY  owner/repo                                  (required)
#   GITHUB_TOKEN       token with contents:write on that repo       (required)
#   GH_PAGES_DEST      prefix for non-production targets, e.g. env/dev
#                      (unset/empty = branch root)
#   PAGES_ROOT         URL path Pages serves the branch at; defaults to
#                      /<repo>. Set to empty for a custom domain or user site.
#   GH_PAGES_BRANCH    branch name (default gh-pages)
#   GH_PAGES_REMOTE    push URL override (default: github.com over the token)
#
# Layout on the branch:
#   /<slot-path>/                production
#   /<GH_PAGES_DEST>/<slot-path>/  any other environment
#
# A slot folder is replaced wholesale. A root site ('' slot) shares its
# directory with other projects' folders, so instead of wiping it the script
# removes exactly the files it deployed last time, listed in .gitflow/root.files.
set -eu

SLOT_PATH="${1-}"
NAME="${2:?name required}"
VERSION="${3:?version required}"

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY (owner/repo) is required}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"

BRANCH="${GH_PAGES_BRANCH:-gh-pages}"
BUNDLE="$(pwd)"
SITE="$BUNDLE/site"
[ -d "$SITE" ] || { echo "gh-pages: site/ not found in bundle $BUNDLE" >&2; exit 1; }

# ── Resolve destination and base href ───────────────────────────────────────
PREFIX="${GH_PAGES_DEST:-}"
PREFIX="${PREFIX#/}"; PREFIX="${PREFIX%/}"
SLOT_PATH="${SLOT_PATH#/}"; SLOT_PATH="${SLOT_PATH%/}"

DEST="$PREFIX"
if [ -n "$SLOT_PATH" ]; then
  DEST="${DEST:+$DEST/}$SLOT_PATH"
fi
case "$DEST" in
  ..|../*|*/..|*/../*) echo "gh-pages: destination escapes the branch: $DEST" >&2; exit 1 ;;
esac

REPO_NAME="${GITHUB_REPOSITORY#*/}"
ROOT="${PAGES_ROOT-/$REPO_NAME}"
ROOT="${ROOT%/}"
BASE="$ROOT/${DEST:+$DEST/}"

echo "gh-pages: $NAME@$VERSION → $BRANCH:/${DEST:-.}  (base href $BASE)"

# ── Prepare a worktree of the branch ────────────────────────────────────────
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
REMOTE="${GH_PAGES_REMOTE:-https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"

git init -q "$WORK"
cd "$WORK"
git remote add origin "$REMOTE"
git config user.name "${GIT_AUTHOR_NAME:-github-actions[bot]}"
git config user.email "${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"

checkout_latest() {
  if git fetch -q --depth=1 origin "$BRANCH" 2>/dev/null; then
    git checkout -q -B "$BRANCH" FETCH_HEAD
  else
    # No branch yet: start it empty.
    git checkout -q --orphan "$BRANCH"
    git rm -rfq --cached . 2>/dev/null || true
    find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  fi
}

# ── Sync the site into place ────────────────────────────────────────────────
rewrite_base_href() {
  index="$1"
  [ -f "$index" ] || return 0
  tmp="$index.tmp"
  if grep -q '<base href=' "$index"; then
    sed "s|<base href=['\"][^'\"]*['\"]|<base href=\"$BASE\"|" "$index" > "$tmp"
  else
    sed "0,/<head[^>]*>/s|<head[^>]*>|&<base href=\"$BASE\">|" "$index" > "$tmp"
  fi
  mv "$tmp" "$index"
}

sync_site() {
  TARGET="$WORK/${DEST:-.}"
  if [ -z "$SLOT_PATH" ]; then
    # Root site: its files sit beside other projects' folders (and env/), so
    # remove only what the previous root deploy wrote.
    MANIFEST="$TARGET/.gitflow/root.files"
    if [ -f "$MANIFEST" ]; then
      owner="$(sed -n 's/^#owner //p' "$MANIFEST")"
      if [ -n "$owner" ] && [ "$owner" != "$NAME" ]; then
        echo "gh-pages: the Pages root at /${DEST:-.} is owned by $owner, not $NAME" >&2
        echo "gh-pages: only one artifact per repo may set pagesRoot" >&2
        exit 1
      fi
      grep -v '^#' "$MANIFEST" | while IFS= read -r f; do
        [ -n "$f" ] && rm -f "$TARGET/$f"
      done
      rm -f "$MANIFEST"
    fi
  else
    rm -rf "$TARGET"
  fi
  mkdir -p "$TARGET"
  cp -R "$SITE/." "$TARGET/"
  rewrite_base_href "$TARGET/index.html"

  if [ -z "$SLOT_PATH" ]; then
    mkdir -p "$TARGET/.gitflow"
    {
      echo "#owner $NAME"
      echo "#version $VERSION"
      (cd "$SITE" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)
    } > "$TARGET/.gitflow/root.files"
  fi

  # Git tracks no empty directories; drop any the removals left behind.
  find "$WORK" -mindepth 1 -type d -empty -not -path "$WORK/.git" -not -path "$WORK/.git/*" -delete
  # Pages runs Jekyll on branch deploys, which drops _-prefixed paths (e.g. _astro/).
  touch "$WORK/.nojekyll"
}

# ── Commit and push, retrying on a concurrent deploy ────────────────────────
attempt=0
while :; do
  checkout_latest
  sync_site
  git add -A
  if git diff --cached --quiet; then
    echo "gh-pages: already up to date"
    exit 0
  fi
  git commit -q -m "deploy: $NAME@$VERSION → /${DEST:-.}"
  if git push -q origin "$BRANCH"; then
    echo "gh-pages: pushed $(git rev-parse --short HEAD) to $BRANCH"
    exit 0
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 5 ]; then
    echo "gh-pages: push rejected $attempt times (concurrent deploys?); giving up" >&2
    exit 1
  fi
  echo "gh-pages: push rejected, re-syncing onto the new head (attempt $attempt)"
  git reset -q --hard
done
