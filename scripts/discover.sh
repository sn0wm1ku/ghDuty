#!/usr/bin/env bash
# ghDuty Step 1 — discover the durable queue, dedupe, apply the ledger fast-skip.
# Pure bash/gh/jq, no LLM. Writes the survivor work-set to /tmp/ghd_items.json
# and prints "survivors: N · fast-skipped: M". Pass its contents as args.items to
# the gh-mentions workflow (Step 3).
set -euo pipefail

DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/ghduty}"
LED="$DIR/skip-ledger"
mkdir -p "$LED"
key(){ echo "$LED/$(echo "$1" | tr '/#' '__').json"; }   # owner/repo#n -> file

# one-time migration of a legacy single-file ledger (so nothing already handled is lost):
if [ -f "$DIR/skip-ledger.jsonl" ]; then
  jq -c '.' "$DIR/skip-ledger.jsonl" | while IFS= read -r l; do
    r=$(echo "$l"|jq -r .repo); n=$(echo "$l"|jq -r .number)
    [ "$r" != null ] && echo "$l" > "$(key "$r#$n")"
  done
  mv "$DIR/skip-ledger.jsonl" "$DIR/skip-ledger.jsonl.migrated"
fi

# three durable queries -> dedupe by repo#number (union src tags).
# review-requested items come from `gh search prs` (no isPullRequest field), so
# force isPR:true whenever "review" is among the srcs — else the handler reads a
# PR with `gh issue view` and misclassifies it.
{ gh search prs    --review-requested=@me --state open --limit 100 --json repository,number,title,url,updatedAt          | jq '[.[]+{src:"review"}]'
  gh search issues --assignee=@me   --include-prs --state open --limit 100 --json repository,number,title,url,isPullRequest,updatedAt | jq '[.[]+{src:"assigned"}]'
  gh search issues --mentions=@me   --include-prs --state open --limit 100 --json repository,number,title,url,isPullRequest,updatedAt | jq '[.[]+{src:"mention"}]'; } \
| jq -s 'add | group_by(.repository.nameWithOwner+"#"+(.number|tostring))
   | map({repo:.[0].repository.nameWithOwner, number:.[0].number, title:.[0].title,
          isPR:((.[0].isPullRequest//false) or any(.[]; .src=="review")), srcs:(map(.src)|unique), updatedAt:.[0].updatedAt})' > /tmp/ghd_all.json

# LEDGER FAST-SKIP: keep only items whose ledgered updatedAt != current (or unledgered):
jq -c '.[]' /tmp/ghd_all.json | while IFS= read -r it; do
  r=$(echo "$it"|jq -r .repo); n=$(echo "$it"|jq -r .number); u=$(echo "$it"|jq -r .updatedAt)
  f="$(key "$r#$n")"
  if [ -f "$f" ] && [ "$(jq -r .updatedAt "$f")" = "$u" ]; then :; else echo "$it"; fi
done | jq -s '.' > /tmp/ghd_items.json

echo "survivors: $(jq length /tmp/ghd_items.json) · fast-skipped: $(( $(jq length /tmp/ghd_all.json) - $(jq length /tmp/ghd_items.json) ))"
