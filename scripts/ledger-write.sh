#!/usr/bin/env bash
# ghDuty per-item ledger write — record a thread's CURRENT updatedAt so the next
# run fast-skips it (no subagent, no thread read) unless there's newer activity.
# Single source of truth for the per-item ledger write: the workflow
# (gh-mentions.js, once per handled item) and SKILL.md both reference this instead
# of re-inlining the jq — the same duplication that hid the isPR bug.
#
# Usage: ledger-write.sh <owner/repo> <number> <issue|pr>
# Re-reads updatedAt AFTER any comment we posted (our own comment bumps it), then
# writes {updatedAt} to the per-key file atomically (temp+rename). Parallel-safe:
# each item writes only its own key, so concurrent workers never race.
set -euo pipefail

repo="${1:?owner/repo required}"
number="${2:?number required}"
kind="${3:?issue|pr required}"

LED="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/ghduty}/skip-ledger"
mkdir -p "$LED"
f="$LED/$(echo "$repo#$number" | tr '/#' '__').json"

U=$(gh "$kind" view "$number" -R "$repo" --json updatedAt -q .updatedAt)
tmp="$(mktemp)"
jq -n --arg u "$U" '{updatedAt:$u}' > "$tmp"
mv "$tmp" "$f"
echo "ledgered $repo#$number @ $U"
