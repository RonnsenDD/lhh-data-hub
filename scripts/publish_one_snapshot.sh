#!/usr/bin/env bash
# Safely publish only allowlisted generated JSON snapshots to main; never force-push.
set -euo pipefail

MAX_ATTEMPTS=3
MESSAGE="Update public data snapshot"

if [[ "$#" -gt 0 && "$1" == "--message" ]]; then
  if [[ "$#" -lt 3 || -z "$2" ]]; then
    echo "Usage: $0 --message <commit-message> <allowlisted-path>..." >&2
    exit 2
  fi
  MESSAGE="$2"
  shift 2
  TARGETS=("$@")
else
  # Backward-compatible single-file form: <path> [commit-message]
  if [[ "$#" -lt 1 ]]; then
    echo "Usage: $0 <allowlisted-path> [commit-message]" >&2
    exit 2
  fi
  TARGETS=("$1")
  shift
  if [[ "$#" -gt 0 ]]; then
    MESSAGE="$1"
    shift
  fi
  if [[ "$#" -gt 0 ]]; then
    echo "Unexpected arguments; use --message before multiple paths." >&2
    exit 2
  fi
fi

if [[ "${#TARGETS[@]}" -eq 0 ]]; then
  echo "At least one publication path is required." >&2
  exit 2
fi

is_allowlisted() {
  case "$1" in
    data/generated/pegel-lauchhammer.json|data/generated/pegel-biehlen-1.json|data/generated/dwd-weather.json|data/generated/graslandfeuerindex.json)
      return 0 ;;
    *) return 1 ;;
  esac
}

for ((i = 0; i < ${#TARGETS[@]}; i++)); do
  target="${TARGETS[$i]}"
  if ! is_allowlisted "$target"; then
    echo "Refusing non-allowlisted publication path: $target" >&2
    exit 2
  fi
  for ((j = 0; j < i; j++)); do
    if [[ "${TARGETS[$j]}" == "$target" ]]; then
      echo "Refusing duplicate publication path: $target" >&2
      exit 2
    fi
  done
done

assert_only_requested_paths() {
  local path target allowed
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    allowed=false
    for target in "${TARGETS[@]}"; do
      if [[ "$path" == "$target" ]]; then
        allowed=true
        break
      fi
    done
    if [[ "$allowed" != true ]]; then
      echo "Refusing publication: unrequested path changed: $path" >&2
      return 1
    fi
  done
}

branch="$(git branch --show-current)"
if [[ "$branch" != "main" ]]; then
  echo "Refusing to publish from branch '$branch'; expected main." >&2
  exit 2
fi
if [[ -n "$(git diff --cached --name-only)" ]]; then
  echo "Refusing to publish with a non-empty index." >&2
  exit 2
fi
changed="$( { git diff --name-only; git ls-files --others --exclude-standard; } | sort -u)"
if ! assert_only_requested_paths <<< "$changed"; then
  exit 2
fi

# Bring the checkout up to date before making a commit. If any requested output
# changed since checkout, do not replace it with this run's candidate.
git fetch --quiet origin main
initial_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse refs/remotes/origin/main)"
if [[ "$initial_head" != "$remote_head" ]]; then
  if ! git diff --quiet "$initial_head" "$remote_head" -- "${TARGETS[@]}"; then
    echo "Refusing publication: a requested output changed on origin/main during this run." >&2
    exit 1
  fi
  git rebase refs/remotes/origin/main
fi

changed="$( { git diff --name-only; git ls-files --others --exclude-standard; } | sort -u)"
if ! assert_only_requested_paths <<< "$changed"; then
  exit 2
fi

git add -- "${TARGETS[@]}"
staged="$(git diff --cached --name-only | sort -u)"
if [[ -z "$staged" ]]; then
  echo "No changes in requested snapshots; nothing to publish."
  exit 0
fi
if ! assert_only_requested_paths <<< "$staged"; then
  exit 1
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git commit -m "$MESSAGE"

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  committed_paths="$(git diff-tree --no-commit-id --name-only -r HEAD | sort -u)"
  if ! assert_only_requested_paths <<< "$committed_paths"; then
    exit 1
  fi
  if git push origin HEAD:refs/heads/main; then
    echo "Published snapshots on main (attempt $attempt):"
    printf '%s\n' "$committed_paths"
    exit 0
  fi

  previous_base="$(git rev-parse HEAD^)"
  git fetch --quiet origin main
  remote_head="$(git rev-parse refs/remotes/origin/main)"
  if [[ "$remote_head" == "$previous_base" ]]; then
    echo "Push failed but origin/main did not advance; refusing blind retry." >&2
    exit 1
  fi
  if ! git diff --quiet "$previous_base" "$remote_head" -- "${TARGETS[@]}"; then
    echo "Push conflict: a requested output changed remotely. No retry will overwrite it." >&2
    exit 1
  fi
  if ! git rebase refs/remotes/origin/main; then
    git rebase --abort || true
    echo "Push conflict could not be rebased safely; aborting." >&2
    exit 1
  fi
  committed_paths="$(git diff-tree --no-commit-id --name-only -r HEAD | sort -u)"
  if ! assert_only_requested_paths <<< "$committed_paths"; then
    echo "Refusing retry: rebased publication commit contains an unexpected path." >&2
    exit 1
  fi
done

echo "Push remained contested after $MAX_ATTEMPTS attempts; aborting without force-push." >&2
exit 1
