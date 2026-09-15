#!/usr/bin/env bash
# verify-shipped.sh — confirms a commit actually landed on this repo's
# production branch before it gets recorded as shipped/deployed.
#
# Root cause this guards against (2026-09, task-1789190167486-g6c9io): a fix
# was committed and repeatedly verified (build/lint/test) on a feature
# branch, then a task ledger recorded it as "shipped to prod" four times in
# a row — without the branch ever being merged into origin/main. Passing CI
# on a feature branch is not evidence of deployment; only ancestry of the
# production branch is.
#
# Usage: scripts/verify-shipped.sh <commit-sha> [branch]
#   <commit-sha>  the commit about to be logged as shipped/deployed
#   [branch]      production branch to check against (default: origin/main)
#
# Exit 0 + "OK" only when <commit-sha> is an ancestor of [branch]. Any other
# outcome (not an ancestor, unknown commit, missing ref) exits non-zero —
# treat that as "do not mark this task shipped".
set -euo pipefail

SHA="${1:?usage: verify-shipped.sh <commit-sha> [branch]}"
BRANCH="${2:-origin/main}"

git fetch origin --quiet

if ! git rev-parse --verify --quiet "${SHA}^{commit}" >/dev/null; then
  echo "verify-shipped: '${SHA}' is not a known commit in this repo" >&2
  exit 2
fi

if git merge-base --is-ancestor "${SHA}" "${BRANCH}"; then
  echo "OK: ${SHA} is an ancestor of ${BRANCH} — safe to record as shipped/deployed."
  exit 0
else
  echo "NOT SHIPPED: ${SHA} is NOT an ancestor of ${BRANCH}." >&2
  echo "This commit exists only on a feature branch (or was never merged/pushed)." >&2
  echo "Do not mark this task as shipped/deployed until it is merged into ${BRANCH}." >&2
  exit 1
fi
