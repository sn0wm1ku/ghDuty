---
name: gh-mentions
description: Triage GitHub issues/PRs that @-mention you (@me) across all repos and handle them one by one — answer questions directly, run /ticket when a mention asks for a code change, run /code-review when a mention asks for a review, and optionally Slack-notify when tickets are left pending. Only picks up mentions updated since the last run. Use when the user says "go through my GitHub mentions", "handle my mentions", or "triage my @mentions".
---

# GitHub mentions triage

Read every thread that @-mentions the authenticated user, then work them one at
a time: decide what each is asking for and dispatch. Only surfaces mentions with
activity since the last run, so already-handled threads don't reappear. Confirm
before anything outward-facing (a comment) or state-changing (a ticket) —
mentions span every repo you can access, so never auto-post in bulk.

## Prerequisite

```bash
gh auth status >/dev/null 2>&1 && echo OK || echo "run: gh auth login"
```

## Step 0 — read last-run timestamp

State lives in the plugin's persistent data dir (survives plugin updates), one
plain ISO-8601 line:

```bash
STATE_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/ghduty}"
mkdir -p "$STATE_DIR"
STATE="$STATE_DIR/last-run"
LAST=$(cat "$STATE" 2>/dev/null)   # empty on first ever run
```

## Step 1 — list mentions since last run

```bash
# with a prior run: only threads updated since LAST
gh search issues --mentions=@me --include-prs --sort updated --limit 50 \
  --updated ">$LAST" \
  --json repository,number,title,state,url,isPullRequest,updatedAt

# first run (LAST empty): drop --updated, list all open mentions
gh search issues --mentions=@me --include-prs --state open --sort updated \
  --limit 50 --json repository,number,title,state,url,isPullRequest,updatedAt
```

`--include-prs` folds PRs in, `@me` is the logged-in user. Show the queue first
(repo, #, title, PR-or-issue) so the user sees what's pending.

## Step 2 — for each mention, read the thread

```bash
gh issue view <number> -R <owner/repo> --comments   # issue
gh pr view    <number> -R <owner/repo> --comments   # pull request
```

Read the mentioning comment plus context; identify what's actually being asked.

## Step 3 — triage into one of three

| The mention is asking for… | Action |
|---|---|
| **A code change / feature / bug fix** | Run `/ticket <concise description>` → lands in `.workaholic/tickets/todo/`. Reply on the thread noting the ticket. |
| **A code review** (usually on a PR) | Run `/code-review` against that PR, then post the findings as a reply. |
| **A question / discussion / anything else** | Draft a direct reply answering it. |

Genuinely ambiguous → ask the user rather than guess.

## Step 4 — act, with a confirmation gate

Before each outward or state-changing action, show the user what you'll do and
get an OK (confirm per item, not per keystroke):

```bash
gh issue comment <number> -R <owner/repo> --body "<reply>"
gh pr comment    <number> -R <owner/repo> --body "<reply>"
```

## Step 5 — Slack notify if tickets are pending (optional)

Slack notification is **opt-in**. It fires only when the env var
`GHDUTY_SLACK_CHANNEL` is set (see the "Slack setup" section of the README) and
there are pending tickets:

```bash
[ -n "$GHDUTY_SLACK_CHANNEL" ] && ls .workaholic/tickets/todo/*.md >/dev/null 2>&1 \
  && echo "notify" || echo "skip"
```

When it says `notify`, send a message with the Slack MCP send-message tool
(`mcp__plugin_slack_slack__slack_send_message`) to the channel in
`$GHDUTY_SLACK_CHANNEL`, listing each pending ticket by title and the
mention/PR it came from. If the var is unset or `todo/` is empty, skip silently —
never require Slack to be configured.

## Step 6 — record this run's timestamp

After the queue is worked, stamp now so the next run only sees newer activity:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE"
```

Report a short summary (handled / ticketed / reviewed / skipped / notified).

## Notes

- `/ticket` writes the ticket; it does not implement. Driving it is a later
  `/drive` step (both from the required `workaholic` plugin).
- For `/code-review` on a specific PR, point it at that PR's diff, not the local
  working tree.
- The `--updated` filter is by *last activity*, not by *replied-yet*: a thread
  you deliberately skipped won't reappear next run unless it gets new activity.
  Stamp the timestamp only after you've actually gone through the queue.
