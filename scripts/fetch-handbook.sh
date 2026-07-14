#!/usr/bin/env bash
# Fetch & cache the OSBR handbook engineering policies from the source repo
# (github.com/osbrjp/handbook, doc/*.md) — the deterministic source of truth
# for OSBR standards. ghDuty skills run this and read the cache as the
# governing criteria when judging or acting on work, so the standards are
# injected by a script rather than left to the model to remember.
#
# Usage: fetch-handbook.sh [--refresh]
#   OSBR_HANDBOOK_CACHE_DIR — override cache location (default ~/.cache/osbr-handbook)
# Prints the cache directory on success. Idempotent unless --refresh.
set -euo pipefail

REPO=osbrjp/handbook
CACHE_DIR="${OSBR_HANDBOOK_CACHE_DIR:-$HOME/.cache/osbr-handbook}"
mkdir -p "$CACHE_DIR"

refresh="${1:-}"

# List doc/*.md dynamically so new policies are picked up without editing this script.
docs=$(gh api "repos/$REPO/git/trees/main?recursive=1" \
        --jq '.tree[] | select(.type=="blob") | .path' | grep -E '^doc/.*\.md$')
[[ -n "$docs" ]] || { echo "no doc/*.md found in $REPO" >&2; exit 1; }

while IFS= read -r path; do
  target="$CACHE_DIR/$(basename "$path")"
  if [[ -s "$target" && "$refresh" != "--refresh" ]]; then continue; fi
  gh api "repos/$REPO/contents/$path?ref=main" --jq '.content' | base64 -d > "$target"
done <<< "$docs"

count=$(find "$CACHE_DIR" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')
[[ "$count" -gt 0 ]] || { echo "cache empty after fetch" >&2; exit 1; }

echo "$CACHE_DIR"
