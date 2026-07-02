---
name: gh-mentions
description: Automated agent that checks GitHub issues/PRs mentioning you (@me) across all repos and handles each action request on its own — replies to questions, runs /ticket on change requests, runs /code-review on review requests, and Slack-notifies when tickets are left pending. The first run lists your open backlog and asks which to handle; later runs are fully automatic, handling only threads with new activity since the last run. Use when the user says "check my GitHub mentions", "handle my mentions", or runs this on a schedule.
---

# GitHub mention duty (automated)

An automated agent. Later runs handle each action request themselves with no
per-item confirmation. The **one exception is the first run**: the open backlog
can be large and stale, so it lists the backlog and asks you which to handle —
after that, it's fully automatic. A last-run timestamp bounds the work set and is
written **only after** the work is handled — never before, so the agent can't
mark mentions done without doing them. Meant to run unattended (e.g. on a
schedule) once the first run has set the baseline.

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

## Step 1 — build the work set

Do NOT stamp here — only after the work is handled (Step 5), so the agent can
never mark mentions done without doing them.

**Later runs** (`LAST` set) — fully automatic, no asking. The work set is every
thread with new activity since `LAST`:

```bash
gh search issues --mentions=@me --include-prs --sort updated --limit 100 \
  --updated ">$LAST" \
  --json repository,number,title,state,url,isPullRequest,updatedAt
```

**First run** (`LAST` empty) — the open backlog can be large and stale, so it's
the user's choice, not an auto-blast. Fetch candidates, **excluding anything with
last activity older than 2 years**, capped at the latest 200:

```bash
CUTOFF=$(date -u -v-2y +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || date -u -d '2 years ago' +%Y-%m-%dT%H:%M:%SZ)   # BSD then GNU
gh search issues --mentions=@me --include-prs --state open --sort updated \
  --updated ">$CUTOFF" --limit 200 \
  --json repository,number,title,state,url,isPullRequest,updatedAt
```

If the result hits 200, tell the user only the latest 200 are being offered
(older ones were not listed).

Then **ask the user which to handle with `AskUserQuestion`, multiSelect (a
checkbox list)** — each option is one mention (`repo#123 — title`). Note the tool
caps a single call at 4 questions × 4 options = **16 checkboxes**; if there are
more candidates, ask in successive rounds until all have been offered. The
first-run work set is only the mentions the user ticks.

If the run is non-interactive (e.g. scheduled) so no selection can be made,
handle none — fall through to Step 5 and stamp the baseline. `--include-prs`
folds PRs in, `@me` is the logged-in user.

## Step 2 — for each, read the thread and classify

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

## Step 3 — handle it automatically

Act without asking. Post replies and open tickets as the classification dictates.

**Every comment the plugin posts must end with this signature**, crediting both
the plugin and the Claude model that wrote the reply. It makes plugin comments
clearly identifiable and easy to find and delete later (issue/PR comments are
freely editable and deletable by the author). Fill in `<model>` with the model
id you are actually running as (e.g. `claude-opus-4-8`, `claude-sonnet-5`):

```
\n\n---\n<sub>🤖 auto-posted by [sn0wm1ku/ghDuty](https://github.com/sn0wm1ku/ghDuty) · co-authored by Claude (<model>)</sub>
```

Build the signature with your own model id substituted in, then append it to
every reply body:

```bash
SIG=$'\n\n---\n<sub>🤖 auto-posted by [sn0wm1ku/ghDuty](https://github.com/sn0wm1ku/ghDuty) · co-authored by Claude (claude-opus-4-8)</sub>'
gh issue comment <number> -R <owner/repo> --body "<reply>$SIG"
gh pr comment    <number> -R <owner/repo> --body "<reply>$SIG"
```

Act only on repos you own or collaborate on. If a mention is on a repo you don't
maintain, note it in the run summary instead of posting.

## Step 4 — Slack notify if tickets are pending (optional)

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

## Step 5 — record this run's timestamp (only now, after handling)

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
