---
name: manage-repos
description: 'Add, remove, or list the extra (often non-org) repos that org-work-summary includes on top of the org-wide search — e.g. a parent company''s org, a personal fork, a partner repo that GHDUTY_ORG''s search misses. Persists them in the plugin''s own config file (config.json) so you don''t hand-edit Claude''s settings.json. Use when the user says "add a repo to the org summary", "track otherorg/repo in the weekly report", "list the extra repos", "remove a repo from ghduty", or "/manage-repos add owner/repo".'
---

# Manage extra repos (org-work-summary)

A tiny config tool for the extra repos `org-work-summary` should include beyond the
org-wide search — the non-org repos where real work happens (a parent company's org,
a personal fork, a partner repo). It edits the **plugin's own config file**, so you
never touch Claude's `settings.json`.

## The plugin's config file

ghDuty keeps its **own** config, separate from Claude's settings and from any
growing cache. Two distinct files under the plugin's own data dir
(`$CLAUDE_PLUGIN_DATA` — a per-plugin directory the harness gives us, **not**
Claude's `settings.json`):

| File | Kind | Grows? | Safe to delete? |
|---|---|---|---|
| `config.json` | **config** — durable settings (extra_repos, …) | no (small) | no — it's your settings |
| `skip-ledger.jsonl` | **cache** — gh-mentions' considered-items ledger | yes (append) | yes — just forces a re-read |

Keep them apart: config is small and durable; the ledger is a bounded cache.

```bash
DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/ghduty}"; CFG="$DIR/config.json"
mkdir -p "$DIR"; [ -f "$CFG" ] || echo '{"extra_repos":[]}' > "$CFG"
```

## Actions

Parse the invocation for one of: `add <owner/repo>…`, `remove <owner/repo>…`,
`list` (default when no args).

### list  (default)
```bash
jq -r '.extra_repos[]? // empty' "$CFG" | sed 's/^/  /' || echo "  (none)"
echo "GHDUTY_EXTRA_REPOS env: ${GHDUTY_EXTRA_REPOS:-none}"   # env additions, for the full picture
```

### add <owner/repo> [more…]
For each argument:
1. **Validate the shape** — must match `^[^/ ]+/[^/ ]+$` (`owner/repo`). Reject otherwise.
2. **Validate it exists and is reachable** (trust boundary — don't persist garbage):
   ```bash
   gh repo view "<owner/repo>" --json nameWithOwner -q .nameWithOwner   # fails on typo / no access
   ```
   If it fails, report it and **do not add**.
3. **Add if new** (idempotent, unique, sorted) via jq:
   ```bash
   tmp="$(mktemp)"; jq --arg r "<owner/repo>" '.extra_repos = (.extra_repos + [$r] | unique)' "$CFG" > "$tmp" && mv "$tmp" "$CFG"
   ```
Report added / already-present / rejected, then show the updated `list`.

### remove <owner/repo> [more…]
```bash
tmp="$(mktemp)"; jq --arg r "<owner/repo>" '.extra_repos -= [$r]' "$CFG" > "$tmp" && mv "$tmp" "$CFG"
```
Then show the updated `list`.

## Notes

- `org-work-summary` reads `config.json`'s `extra_repos` **unioned with** the
  `GHDUTY_EXTRA_REPOS` env var and any `GHDUTY_PROJECT` board repos.
- Repos here are queried with `gh search … -R <owner/repo>` (per-repo), so non-org
  repos the `GHDUTY_ORG` search can't see get counted.
- Read-only elsewhere: this tool only writes its own `config.json`; it never touches
  `settings.json` or any repo.
