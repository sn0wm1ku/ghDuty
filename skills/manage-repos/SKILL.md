---
name: manage-repos
description: 'Add, remove, or list the extra (often non-org) repos that org-work-summary includes on top of the org-wide search — e.g. a parent company''s org, a personal fork, or every client repo a team tracks that GHDUTY_ORG''s search misses. Bare `/manage-repos` runs an interactive dialog (point at / upload a file, or add repos one by one), validating each exists; explicit `add`/`remove`/`list` sub-commands also work. Persists to the plugin''s own list file (extra-repos.txt, one owner/repo per line) so you don''t hand-edit Claude''s settings.json. Use when the user says "add a repo to the org summary", "track otherorg/repo in the weekly report", "list the extra repos", "remove a repo from ghduty", or "/manage-repos".'
---

# Manage extra repos (org-work-summary)

A tiny config tool for the extra repos `org-work-summary` should include beyond the
org-wide search — the non-org repos where real work happens (a parent company's org,
a personal fork, a partner/client repo). It edits the **plugin's own list file**, so
you never touch Claude's `settings.json`.

## The list file

The extra-repos list gets its **own** file — it's a list that can grow large (a team
may track every client repo), and a flat text file is bulk-editable (paste a whole
list, `#`-comment lines, git-friendly) without re-serializing anything. It lives
under the plugin's own data dir (`$CLAUDE_PLUGIN_DATA` — a per-plugin directory the
harness gives us, **not** Claude's `settings.json`), kept separate from the
gh-mentions cache (`skip-ledger/`):

```bash
DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/ghduty}"; REPOS="$DIR/extra-repos.txt"
mkdir -p "$DIR"; touch "$REPOS"   # one owner/repo per line; blank lines & # comments ignored
```

## Actions

If the invocation carries an explicit sub-command (`add <owner/repo>…`,
`remove <owner/repo>…`, `list`), do that directly. **Otherwise (bare
`/manage-repos`, or unclear input) run the interactive dialog** — don't guess.

### Interactive dialog (default)

Ask the user how they want to update the list (`AskUserQuestion`), then act:

1. **From a file** — ask for a path to a file, or for them to paste/upload a list
   (one `owner/repo` per line; `#` comments and blank lines ignored). Read it, and
   for each line run the **add validation** below. Report added / duplicate /
   rejected counts. Good for bulk (a whole client-repo list at once).
2. **Add one by one** — ask for a repo (`owner/repo`), validate + append, then ask
   "another?" and loop until they're done.
3. **List current** — show the list (below).
4. **Remove** — ask which `owner/repo` to drop, then remove (below).

Then always show the updated `list`.

### list  (default)
```bash
grep -vE '^\s*(#|$)' "$REPOS" | sed 's/^/  /' || echo "  (none)"
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
3. **Append if new** (idempotent — no duplicates):
   ```bash
   grep -qxF "<owner/repo>" "$REPOS" || echo "<owner/repo>" >> "$REPOS"
   ```
Report added / already-present / rejected, then show the updated `list`. Bulk add is
just many lines appended — a user can also paste a big list straight into the file.

### remove <owner/repo> [more…]
```bash
tmp="$(mktemp)"; grep -vxF "<owner/repo>" "$REPOS" > "$tmp" && mv "$tmp" "$REPOS"
```
Then show the updated `list`.

## Notes

- `org-work-summary` reads this file **unioned with** the `GHDUTY_EXTRA_REPOS` env
  var and any `GHDUTY_PROJECT` board repos.
- Repos here are queried with `gh search … -R <owner/repo>` (per-repo), so non-org
  repos the `GHDUTY_ORG` search can't see get counted.
- Read-only elsewhere: this tool only writes its own `extra-repos.txt`; it never
  touches `settings.json` or any repo.
