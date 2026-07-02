---
name: gh-mentions
description: Automated agent that works your GitHub notification inbox — the comment/event-level things actually directed at you (mentions, review requests, assignments, replies on threads you're in) across all repos — and handles each on its own: replies to questions, runs /ticket on change requests, runs /code-review on review requests, Slack-notifies on pending tickets. Idempotent by notification read-state (handles unread, marks read when done). Use when the user says "check my GitHub mentions", "handle my mentions", "work my GitHub inbox", or runs this on a schedule.
---

# GitHub notification duty (automated)

An automated agent. It works your **GitHub notification inbox**, not an
issue-level `mentions:` search — so it catches the things actually directed at
you at the comment/event level: `mention`, `review_requested`, `assign`,
`comment` (a reply on a thread you're in), `author` (activity on something you
opened). It **handles each unread item itself** and **marks it read when done**;
read-state is the idempotency — no timestamps, no re-handling.

## Prerequisite

```bash
gh auth status >/dev/null 2>&1 && echo OK || echo "run: gh auth login"
```

(The token needs notification access; the `repo` scope from `gh auth login`
covers it. Verify once with `gh api /notifications >/dev/null`.)

## Step 0 — bootstrap (checked every run; acts only when something's missing)

Two things must exist before handling. Detect both; set up whatever's absent.

**(a) Working folder — checked EVERY run.** This is where repos live / get cloned
so `/ticket` lands in the right repo (see Step 4). Two gates, every time the
skill is triggered:

1. **Path known?** If `GHDUTY_WORK_DIR` is unset and its default doesn't exist,
   **ask the user for the path** (`AskUserQuestion`) and tell them to persist it:
   `"env": { "GHDUTY_WORK_DIR": "<path>" }` in settings.
2. **In the session?** If that folder is **not** already one of this session's
   working directories, **ask the user's permission to work on it**, and only
   after they agree add it with `/add-dir <path>`. ghDuty must not clone into or
   write to a folder the user hasn't granted this session.

```bash
WORK="${GHDUTY_WORK_DIR:-$HOME/Projects}"
echo "working folder: $WORK"
# 1. no path → AskUserQuestion for it.
# 2. not in session → ask permission, then /add-dir "$WORK". Only proceed once granted.
```

**(b) First-run marker** — distinguishes the first ever start (whole unread inbox
is a backlog to triage) from routine runs (just the new unread). It is written
only at the very end (Step 6), after handling:

```bash
STATE_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/ghduty}"; mkdir -p "$STATE_DIR"
MARK="$STATE_DIR/initialized"
FIRST_RUN=1; [ -f "$MARK" ] && FIRST_RUN=0
echo "first run: $FIRST_RUN"
```

## Step 1 — read the unread inbox

```bash
gh api "/notifications?all=false&per_page=50" --paginate \
  --jq '.[] | {id, reason, repo: .repository.full_name, type: .subject.type,
               title: .subject.title, url: .subject.url,
               latest: .subject.latest_comment_url, updated: .updated_at}'
```

Each item is one actionable thread. `id` is the notification thread id (used to
mark read in Step 5). `subject.url` is the API URL of the issue/PR — parse
`owner/repo` and the number from it. `reason` tells you why it's in your inbox.

## Step 2 — pick what to handle

- **First run (`FIRST_RUN=1`) and interactive** → the whole unread inbox is a
  backlog; present it as an `AskUserQuestion` multiSelect (checkbox) list and
  handle only the ticked ones (a single call caps at 4 questions × 4 options =
  16; ask in rounds if more). Unticked items are left **unread** so they
  resurface next time.
- **Routine run, or non-interactive / scheduled** → handle every unread item
  automatically, no asking.

## Step 3 — fan out: one subagent per notification (parallel)

Handle the work set concurrently — spawn **one subagent per notification** with
the `Agent` tool, launched in parallel (multiple `Agent` calls in a single
message). Each subagent owns its one item end-to-end and returns a structured
result: `{repo, number, action: replied|ticketed|reviewed|skipped, ticket_path?, note}`.

The orchestrator (you) collects the results for Step 4–5. Do NOT handle items
yourself in a loop — delegate each to its own subagent so they run at once.

**Before fanning out, dedupe the target repos and clone each unique one once**
(Step 4's working-folder clone). Two subagents cloning the same repo concurrently
would clash; once the clone exists, parallel `/ticket` writes into it are separate
files and are safe.

### What each per-notification subagent does

Give the subagent the notification's `{repo, number, type, reason, thread id}` and
the signature model, and have it:

1. **Read** the thread's latest activity (the comment that put it in the inbox):

   ```bash
   gh issue view <number> -R <owner/repo> --comments   # Issue
   gh pr view    <number> -R <owner/repo> --comments   # PullRequest
   ```

2. **Classify** using `reason` + the latest comment (table below).
3. **Handle** per Step 4 (reply / ticket-in-clone / code-review), signed.
4. **Mark read** per Step 6 for its own thread.
5. **Return** the structured result.

Classification (used by each subagent):

| Signal | Handle it by |
|---|---|
| `review_requested`, or a comment asking for review | Run `/code-review` on that PR, post the findings as a reply. |
| A change / feature / bug-fix request (any reason) | Run `/ticket <concise description>`, then reply noting the ticket. |
| A direct question | Reply with the answer. |
| Nothing actionable (FYI, ack, already resolved) | Skip — no reply, but still mark read in Step 5 so it drains from the inbox. |

## Step 4 — how each subagent handles its item

Act without asking. Post replies and open tickets per the classification.

**Change requests → file the ticket in the target repo's clone under the working
folder, not cwd.** `/ticket` (workaholic) writes to `.workaholic/tickets/todo/`
relative to the current directory, but ghDuty runs from an arbitrary folder
across many repos — the cwd is almost never the repo the mention is about. So
use the **working folder** (`GHDUTY_WORK_DIR`, default `~/Projects`) where repos
live as `<owner>/<repo>`; clone the repo there on demand if it isn't present,
then run `/ticket` inside it so the ticket lands in that repo and is wired to its
`/drive`:

```bash
WORK="${GHDUTY_WORK_DIR:-$HOME/Projects}"   # the working folder
CLONE="$WORK/<owner>/<repo>"
if [ ! -d "$CLONE/.git" ]; then
  gh repo clone "<owner>/<repo>" "$CLONE" || echo "clone failed (no access?)"
fi
cd "$CLONE"          # then run /ticket <desc> — lands in this repo's .workaholic/tickets/todo/
```

If the clone fails (no access / repo gone), don't lose the request: note it in
the reply and the run summary instead. Track which tickets this run created
(repo, title, path) — Step 5 needs them. Reply on the thread noting where the
ticket was filed.

**Every comment the plugin posts must end with this signature** — it credits the
plugin and the Claude model and makes plugin comments easy to find and delete
(issue/PR comments are freely editable and deletable by the author). Fill in
`<model>` with the model id you are actually running as:

```bash
SIG=$'\n\n---\n<sub>🤖 auto-posted by [sn0wm1ku/ghDuty](https://github.com/sn0wm1ku/ghDuty) · co-authored by Claude (claude-opus-4-8)</sub>'
gh issue comment <number> -R <owner/repo> --body "<reply>$SIG"
gh pr comment    <number> -R <owner/repo> --body "<reply>$SIG"
```

Act only on repos you own or collaborate on. If an item is on a repo you don't
maintain, note it in the run summary instead of posting (still mark it read).

## Step 5 — Slack notify about tickets created this run (optional)

Opt-in, fires only when `GHDUTY_SLACK_WEBHOOK` is set (a Slack Incoming Webhook
URL — see README "Slack setup") and this run created at least one ticket.
Tickets land in per-repo clones (Step 4), so notify from the subagents' returned
results (the `ticketed` ones), not a directory scan. The webhook posts as its own app, so you
actually get notified. Build `MSG` listing each created ticket (repo + title +
source thread), then:

```bash
if [ -n "$GHDUTY_SLACK_WEBHOOK" ]; then   # and this run created ≥1 ticket
  curl -sS -X POST -H 'Content-type: application/json' \
    --data "$(jq -n --arg t "$MSG" '{text:$t}')" "$GHDUTY_SLACK_WEBHOOK" >/dev/null
fi
```

If the var is unset or no ticket was created, skip silently.

## Step 6 — mark read (each subagent) + write the marker (orchestrator)

**Each subagent**, after it has handled or triaged-as-skip its own item, marks
that notification thread read so it doesn't come back — last thing it does, never
before handling. Un-ticked items are left unread (their subagent isn't spawned).

```bash
gh api -X PATCH "/notifications/threads/<id>"
```

**The orchestrator**, once all subagents have returned, writes the first-run
marker (Step 0b) so later runs skip the backlog prompt:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ > "$MARK"
```

Report a short summary: replied / ticketed / reviewed / skipped-drained /
left-unread / notified.

## Notes

- Read-state is the idempotency: handled → read, untouched → stays unread. A
  thread re-enters your inbox (unread again) when there's new activity, which is
  exactly when it should be re-handled.
- `/ticket` writes the ticket; it does not implement. Driving it is a later
  `/drive` step (both from the required `workaholic` plugin).
- For `/code-review` on a specific PR, point it at that PR's diff.
