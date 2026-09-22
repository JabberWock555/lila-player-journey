#!/usr/bin/env bash
# Build and publish to the gh-pages branch (the fallback host — Vercel is primary).
#   ./deploy.sh
#
# Publishes dist/ as a single fresh commit on gh-pages. Safe to re-run: the
# worktree and its temporary branch are created and removed each time, so a
# previous run's leftovers never block this one.
set -euo pipefail

REPO_NAME="$(basename "$(git rev-parse --show-toplevel)")"
REPO_ROOT="$(git rev-parse --show-toplevel)"
export BASE_PATH="/${REPO_NAME}/"

npm run build
touch dist/.nojekyll          # keep Pages from hiding /assets and _-prefixed files

WORKTREE="$(mktemp -d)"
TMP_BRANCH="gh-pages-publish-$$"

cleanup() {
  git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" 2>/dev/null || true
  git -C "$REPO_ROOT" branch -D "$TMP_BRANCH" 2>/dev/null || true
}
trap cleanup EXIT

# Orphan branch under a unique name, so re-runs never collide with the local
# gh-pages ref left behind by a previous publish.
git -C "$REPO_ROOT" worktree add --detach "$WORKTREE" >/dev/null
git -C "$WORKTREE" checkout --orphan "$TMP_BRANCH" >/dev/null 2>&1
git -C "$WORKTREE" rm -rq --cached . 2>/dev/null || true
find "$WORKTREE" -maxdepth 1 ! -path "$WORKTREE" ! -name .git -exec rm -rf {} +

cp -R dist/. "$WORKTREE"/
git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -qm "Deploy $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
git -C "$WORKTREE" push -qf origin "HEAD:gh-pages"

OWNER="$(git remote get-url origin | sed -E 's#.*github.com[:/]([^/]+)/.*#\1#' | tr 'A-Z' 'a-z')"
echo "Pushed to gh-pages -> https://${OWNER}.github.io/${REPO_NAME}/"

# Pages does not always rebuild on a branch push, so ask for one explicitly.
if command -v gh >/dev/null 2>&1; then
  gh api -X POST "repos/$(git remote get-url origin | sed -E 's#.*github.com[:/]([^/]+/[^/.]+)(\.git)?#\1#')/pages/builds" \
    >/dev/null 2>&1 && echo "Requested a Pages rebuild." \
    || echo "Could not request a Pages rebuild — trigger it from the repo's Pages settings."
fi
