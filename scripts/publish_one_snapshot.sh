#!/usr/bin/env bash
# Safely publish exactly one generated JSON file to main; never force-push.
set -euo pipefail

TARGET="${1:-}"
MESSAGE="${2:-Update public data snapshot}"
MAX_ATTEMPTS=3
case "$TARGET" in
  data/generated/pegel-lauchhammer.json|data/generated/pegel-biehlen-1.json|data/generated/dwd-weather.json) ;;
  *) echo "Refusing non-allowlisted publication path: $TARGET" >&2; exit 2 ;;
esac

branch="$(git branch --show-current)"
if [[ "$branch" != "main" ]]; then
  echo "Refusing to publish from branch '$branch'; expected main." >&2
  exit 2
fi
if [[ -n "$(git diff --cached --name-only)" ]]; then
  echo "Refusing to publish with a non-empty index." >&2
  exit 2
fi
changed="$(git diff --name-only)"
if [[ -n "$changed" && "$changed" != "$TARGET" ]]; then
  echo "Refusing to publish: tracked changes include paths other than $TARGET: $changed" >&2
  exit 2
fi

# Bring the checkout up to date before making a commit. If the same output
# changed since checkout, do not replace it with this run's older candidate.
git fetch --quiet origin main
initial_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse refs/remotes/origin/main)"
if [[ "$initial_head" != "$remote_head" ]]; then
  if ! git diff --quiet "$initial_head" "$remote_head" -- "$TARGET"; then
    echo "Refusing publication: $TARGET changed on origin/main during this run." >&2
    exit 1
  fi
  git rebase refs/remotes/origin/main
fi

git add -- "$TARGET"
staged="$(git diff --cached --name-only)"
if [[ "$staged" != "$TARGET" ]]; then
  echo "Refusing publication: staged paths are not exactly $TARGET: $staged" >&2
  exit 1
fi
if git diff --cached --quiet; then
  echo "No changes in $TARGET; nothing to publish."
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git commit -m "$MESSAGE"

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  committed_paths="$(git diff-tree --no-commit-id --name-only -r HEAD)"
  if [[ "$committed_paths" != "$TARGET" ]]; then
    echo "Refusing publication: commit contains unexpected paths: $committed_paths" >&2
    exit 1
  fi
  if git push origin HEAD:refs/heads/main; then
    echo "Published $TARGET on main (attempt $attempt)."
    exit 0
  fi

  previous_base="$(git rev-parse HEAD^)"
  git fetch --quiet origin main
  remote_head="$(git rev-parse refs/remotes/origin/main)"
  if [[ "$remote_head" == "$previous_base" ]]; then
    echo "Push failed but origin/main did not advance; refusing blind retry." >&2
    exit 1
  fi
  if ! git diff --quiet "$previous_base" "$remote_head" -- "$TARGET"; then
    echo "Push conflict: $TARGET changed remotely. No retry will overwrite it." >&2
    exit 1
  fi
  if ! git rebase refs/remotes/origin/main; then
    git rebase --abort || true
    echo "Push conflict could not be rebased safely; aborting." >&2
    exit 1
  fi
  if [[ "$(git diff-tree --no-commit-id --name-only -r HEAD)" != "$TARGET" ]]; then
    echo "Refusing retry: rebased publication commit has unexpected paths." >&2
    exit 1
  fi
done

echo "Push remained contested after $MAX_ATTEMPTS attempts; aborting without force-push." >&2
exit 1
