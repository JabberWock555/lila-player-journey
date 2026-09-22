#!/usr/bin/env bash
# Build and publish to the gh-pages branch.
#   ./deploy.sh
# Pages is configured to serve that branch's root.
set -euo pipefail

REPO_NAME="$(basename "$(git rev-parse --show-toplevel)")"
export BASE_PATH="/${REPO_NAME}/"

npm run build
touch dist/.nojekyll          # keep Pages from hiding /assets and _-prefixed files

WORKTREE="$(mktemp -d)"
git worktree add --detach "$WORKTREE" >/dev/null
pushd "$WORKTREE" >/dev/null
  git checkout --orphan gh-pages >/dev/null 2>&1
  git rm -rq --cached . 2>/dev/null || true
  find . -maxdepth 1 ! -name . ! -name .git -exec rm -rf {} +
popd >/dev/null

cp -R dist/. "$WORKTREE"/
pushd "$WORKTREE" >/dev/null
  git add -A
  git commit -qm "Deploy $(git -C "$OLDPWD" rev-parse --short HEAD)"
  git push -qf origin gh-pages
popd >/dev/null

git worktree remove --force "$WORKTREE"
echo "Deployed -> https://$(git remote get-url origin | sed -E 's#.*github.com[:/]([^/]+)/.*#\1#' | tr 'A-Z' 'a-z').github.io/${REPO_NAME}/"
