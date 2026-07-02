---
name: gh-mentions
description: Automated agent that finds the GitHub work actually waiting on you across all repos — PRs awaiting your review, issues/PRs assigned to you, and issues/PRs that @-mention you — and handles each on its own, in parallel: replies to questions, runs /ticket on change requests, runs /code-review on review requests, Slack-notifies on tickets created. Uses durable state queries (not the ephemeral notification inbox, which drops assigned/read items); idempotent by its own reply signature. Use when the user says "check my GitHub mentions", "handle my mentions", "work my GitHub queue", or runs this on a schedule.
---

# GitHub duty (automated)

An automated agent that keeps your GitHub queue moving, its core job being to
**automate your pending tasks**. It builds the queue from durable GitHub state
(assigned + mentioned + review-requested, all open, across all repos — GitHub is
the record) and handles each item in parallel by subtype:

- **assigned issue that already has a linked PR** (osbr auto-opens a PR on assign)
  → leave a signed acknowledgment comment; the PR is handled by the PR rule.
- **assigned issue with no PR** (an idea/discussion) → open a ticket in the repo's
  clone, push a ticket branch, and Slack you to `/drive` it.
- **assigned PR** → closed: skip; open (in progress): skip for now (testing phase).
- **mention** → reply (skip if the mentioning comment is >2 years old).
- **review request** → `/code-review`, post findings.

Idempotent by its own signature (a thread with a ghDuty reply and nothing newer
is done) and, for idea-issue tickets, by the ticket already existing in the clone.

## Prerequisite

```bash
gh auth status >/dev/null 2>&1 && echo OK || echo "run: gh auth login"
```

## Step 0 — bootstrap (checked every run; acts only when something's missing)

**(a) Working folder — checked EVERY run.** Where repos live / get cloned so
`/ticket` lands in the right repo (Step 4). Two gates each time:

1. **Path known?** If `GHDUTY_WORK_DIR` is unset and its default doesn't exist,
   **ask the user for the path** (`AskUserQuestion`) and tell them to persist it:
   `"env": { "GHDUTY_WORK_DIR": "<path>" }` in settings.
2. **In the session?** If that folder is **not** already one of this session's
   working directories, **ask the user's permission**, and only after they agree
   add it with `/add-dir <path>`. Never clone into / write to an ungranted folder.

```bash
WORK="${GHDUTY_WORK_DIR:-$HOME/Projects}"; echo "working folder: $WORK"
```

**(b) First-run marker** — gates the backlog prompt (Step 2). Written only at the
end (Step 6):

```bash
STATE_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/ghduty}"; mkdir -p "$STATE_DIR"
MARK="$STATE_DIR/initialized"; FIRST_RUN=1; [ -f "$MARK" ] && FIRST_RUN=0
echo "first run: $FIRST_RUN"
```

## Step 1 — build the work set (durable queries)

Union of three durable queries — these reflect current state, so they don't
vanish when a notification is read:

```bash
# PRs awaiting your review
gh search prs --review-requested=@me --state open --limit 100 \
  --json repository,number,title,url,updatedAt
# issues/PRs assigned to you
gh search issues --assignee=@me --include-prs --state open --limit 100 \
  --json repository,number,title,url,isPullRequest,updatedAt
# issues/PRs that @-mention you
gh search issues --mentions=@me --include-prs --state open --limit 100 \
  --json repository,number,title,url,isPullRequest,updatedAt
```

Dedupe by `repo#number`; tag each with why it's here (review-requested /
assigned / mentioned). This is the full queue of GitHub work waiting on you.

## Step 2 — pick what to handle

- **First run (`FIRST_RUN=1`) and interactive** → the queue may be large; present
  it as an `AskUserQuestion` multiSelect (checkbox) list and handle only ticked
  items (caps at 4 questions × 4 options = 16 per call; ask in rounds if more).
- **Routine run, or non-interactive / scheduled** → handle every item, no asking.

## Step 3 — fan out: one subagent per item (parallel)

Spawn **one subagent per queue item** with the `Agent` tool, launched in parallel
(multiple `Agent` calls in one message). Each returns
`{repo, number, action: replied|ticketed|reviewed|skipped, ticket_path?, note}`.
The orchestrator collects results for Steps 4–5. **Dedupe target repos and clone
each unique one once before fan-out** (Step 4) — concurrent clones of the same
repo clash; separate `/ticket` writes into an existing clone are safe.

### What each per-item subagent does

1. **Read** the thread and its latest activity:
   ```bash
   gh issue view <number> -R <owner/repo> --comments   # Issue
   gh pr view    <number> -R <owner/repo> --comments   # PullRequest
   ```
2. **Idempotency check** —
   - *mention / review / assigned-issue-with-PR (ack)*: if the thread already has
     a ghDuty signature (`auto-posted by sn0wm1ku/ghDuty`) with **no newer comment
     after it**, it's handled → return `skipped` (don't re-comment / re-ack).
   - *assigned idea-issue (ticket)*: if the repo's clone already has a ticket whose
     frontmatter `source:` points at this `owner/repo#number` (in
     `.workaholic/tickets/` todo **or** archived), it exists → return `skipped`.
3. **Classify** (table below) and **handle** per Step 4, signed.
4. **Return** the structured result.

Action is driven by **which query surfaced the item** and, for assigned items,
its subtype. An item can be in more than one query; do all that apply.

| Source / signal | Handle it by |
|---|---|
| **assigned ISSUE with a linked PR** (the osbr repos auto-open a PR when you're assigned; you're already assigned on that PR) | Leave an **acknowledgment comment** on the issue: `Acknowledged <UTC date time>.` (signed). The linked PR is handled by the assigned-PR rule below. |
| **assigned ISSUE with no PR** (usually an idea/discussion — still needs a response) | Open a **ticket** in the repo's clone, **create + push a new branch** for the ticket, then **Slack** to drive it (Step 5). |
| **assigned PR** | **Closed → skip.** **Open (implementation in progress) → skip for now** (we're in a testing phase; future runs will handle these). |
| **review-requested**, or a comment asking for review | Run `/code-review` on that PR, post the findings as a reply. |
| **mentioned**, and the mention asks something | Reply — answer a question, or ticket + reply if it's a change request. **Skip if the mentioning comment itself is >2 years old** (judge by the comment's `created_at`, not the issue's; a stale @ isn't worth answering). |
| Genuinely nothing to do (pure FYI, an ack, already resolved) | Skip. |

Age note: the 2-year cutoff applies **only** to the mention line. Assigned items
and review requests are handled regardless of age (an assigned task still needs
doing; a review is still requested).

**Detecting a linked PR** for an assigned issue: check the issue's timeline /
`closedByPullRequestsReferences`, or search `gh pr list -R <repo> --search "<issue#>"`.
If a PR references/closes the issue and you're assigned on it, treat the issue as
"has linked PR" (acknowledge only).

## Step 4 — how each subagent handles its item

Act without asking. Post replies and open tickets per the classification.

**Tickets go in the target repo's clone under the working folder, not cwd, and
get their own pushed branch.** `/ticket` (workaholic) writes to
`.workaholic/tickets/todo/` relative to cwd, but ghDuty runs from an arbitrary
folder. Use the **working folder** (`GHDUTY_WORK_DIR`, default `~/Projects`),
clone the repo on demand, make a ticket branch, run `/ticket` inside it, then push:

```bash
WORK="${GHDUTY_WORK_DIR:-$HOME/Projects}"
CLONE="$WORK/<owner>/<repo>"
[ -d "$CLONE/.git" ] || gh repo clone "<owner>/<repo>" "$CLONE" || echo "clone failed"
cd "$CLONE"
git switch -c "ghduty/ticket-<issue#>-<slug>" origin/HEAD   # new branch off default
# run /ticket <desc>  → writes .workaholic/tickets/todo/<...>.md (source: owner/repo#n)
git add .workaholic/tickets/ && git commit -m "ghduty: ticket for #<issue#>"
git push -u origin "ghduty/ticket-<issue#>-<slug>"
```

If the clone or push fails, note it in the summary instead of losing the item.
Record `{repo, issue, ticket_path, branch}` for the Slack step.

**Acknowledgment comments** (assigned issue that already has a linked PR) are just
a signed comment on the issue — no ticket, no branch:

```bash
gh issue comment <number> -R <owner/repo> --body "Acknowledged $(date -u +'%Y-%m-%d %H:%M UTC').$SIG"
```

**Every comment the plugin posts must end with this signature** — it credits the
plugin and the Claude model, makes comments easy to find/delete, and is what the
Step 3 idempotency check keys on. Fill `<model>` with the model you're running as:

```bash
SIG=$'\n\n---\n<sub>🤖 auto-posted by [sn0wm1ku/ghDuty](https://github.com/sn0wm1ku/ghDuty) · co-authored by Claude (claude-opus-4-8)</sub>'
gh issue comment <number> -R <owner/repo> --body "<reply>$SIG"
gh pr comment    <number> -R <owner/repo> --body "<reply>$SIG"
```

Act only on repos you own or collaborate on. If it's a repo you don't maintain,
note it in the summary instead of posting.

## Step 5 — Slack notify about tickets created this run (optional)

Opt-in, fires only when `GHDUTY_SLACK_WEBHOOK` is set (see README "Slack setup")
and this run created ≥1 ticket. Notify from the subagents' `ticketed` results —
list each ticket with its repo, source issue, and the **branch that was pushed**,
so you can `/drive` it. The webhook posts as its own app, so you actually get
notified:

```bash
if [ -n "$GHDUTY_SLACK_WEBHOOK" ]; then   # and ≥1 ticket created
  curl -sS -X POST -H 'Content-type: application/json' \
    --data "$(jq -n --arg t "$MSG" '{text:$t}')" "$GHDUTY_SLACK_WEBHOOK" >/dev/null
fi
```

If unset or no ticket was created, skip silently.

## Step 6 — write the first-run marker

Once all subagents have returned, write the marker so later runs skip the backlog
prompt:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ > "$MARK"
```

Report a short summary: replied / ticketed / reviewed / skipped-already-answered /
skipped-not-mine / left-unticked / notified.

## Notes

- **Idempotency is the signature**, not notification read-state: a thread is
  "done" while it carries a ghDuty reply with nothing after it, and becomes
  actionable again when someone comments after that reply — exactly right.
- Durable queries catch assigned work and review requests that the notification
  inbox drops once read; the tradeoff is one thread read per item to check the
  signature. Fine for a scheduled agent.
- `/ticket` writes the ticket; driving it is a later `/drive` step (both from the
  required `workaholic` plugin). For `/code-review`, point it at the PR's diff.
