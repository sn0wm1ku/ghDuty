---
name: gh-mentions
description: Automated agent that checks GitHub issues/PRs mentioning you (@me) across all repos and handles each action request on its own — replies to questions, runs /ticket on change requests, runs /code-review on review requests, and Slack-notifies when tickets are left pending. Handles only mentions with new activity since the last run (no re-handling). Use when the user says "check my GitHub mentions", "handle my mentions", or runs this on a schedule.
---

# GitHub mention duty (automated)

An automated agent, not an interactive checklist. On each run it checks for new
mentions and **handles each action request itself** — no per-item confirmation.
It handles only mentions that have new activity since the last run, so nothing is
touched twice. Meant to run unattended (e.g. on a schedule).

## Prerequisite

```bash
gh auth status >/dev/null 2>&1 && echo OK || echo "run: gh auth login"
```

## Step 0 — read last-run timestamp

State lives in the plugin's persistent data dir (survives updates):

```bash
STATE_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/ghduty}"
mkdir -p "$STATE_DIR"
STATE="$STATE_DIR/last-run"
LAST=$(cat "$STATE" 2>/dev/null)
```

## Step 1 — first run establishes a baseline, it does NOT drain the backlog

If `LAST` is empty this is the first run. Do **not** handle the entire
historical backlog. Stamp now and stop — the agent starts watching from here:

```bash
if [ -z "$LAST" ]; then
  date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE"
  echo "baseline set — will handle mentions with new activity from now on"
  exit 0
fi
```

## Step 2 — list mentions with new activity since last run

```bash
gh search issues --mentions=@me --include-prs --sort updated --limit 50 \
  --updated ">$LAST" \
  --json repository,number,title,state,url,isPullRequest,updatedAt
```

`--include-prs` folds PRs in, `@me` is the logged-in user. This is the work set:
only threads that changed since the baseline.

## Step 3 — for each, read the thread and classify

```bash
gh issue view <number> -R <owner/repo> --comments   # issue
gh pr view    <number> -R <owner/repo> --comments   # pull request
```

Look at the newest activity — the comment that mentions you and anything after
it. Classify what it wants:

| The mention is… | Handle it by |
|---|---|
| **A change / feature / bug-fix request** | Run `/ticket <concise description>`, then reply on the thread noting the ticket. |
| **A review request** (usually a PR) | Run `/code-review` on that PR, then post the findings as a reply. |
| **A direct question** | Reply with the answer. |
| **Not an action request** (FYI, drive-by mention, resolved) | Skip — no reply. |

## Step 4 — handle it automatically

Act without asking. Post replies and open tickets as the classification dictates:

```bash
gh issue comment <number> -R <owner/repo> --body "<reply>"
gh pr comment    <number> -R <owner/repo> --body "<reply>"
```

Act only on repos you own or collaborate on. If a mention is on a repo you don't
maintain, note it in the run summary instead of posting.

## Step 5 — Slack notify if tickets are pending (optional)

Opt-in, fires only when `GHDUTY_SLACK_WEBHOOK` is set (a Slack Incoming Webhook
URL — see README "Slack setup") and there are pending tickets. The webhook posts
as its own app, so you actually get notified. Build `MSG` listing each pending
ticket by title and its originating mention/PR, then:

```bash
if [ -n "$GHDUTY_SLACK_WEBHOOK" ] && ls .workaholic/tickets/todo/*.md >/dev/null 2>&1; then
  curl -sS -X POST -H 'Content-type: application/json' \
    --data "$(jq -n --arg t "$MSG" '{text:$t}')" "$GHDUTY_SLACK_WEBHOOK" >/dev/null
fi
```

If the var is unset or `todo/` is empty, skip silently.

## Step 6 — record this run's timestamp

Stamp now so the next run only sees newer activity:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE"
```

Report a short summary (handled / ticketed / reviewed / skipped / notified).

## Notes

- `/ticket` writes the ticket; it does not implement. Driving it is a later
  `/drive` step (both from the required `workaholic` plugin).
- For `/code-review` on a specific PR, point it at that PR's diff.
- The `--updated` filter is by last activity: a thread only re-enters the work
  set when it gets new activity after the last run.
- To run this unattended, schedule it (e.g. Claude Code `/schedule` or a cron
  that runs the skill), so mentions get handled without you invoking it.
