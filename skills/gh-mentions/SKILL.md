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
- **assigned PR** → closed: skip; open: read the PR *and its linked issue* (the
  objective lives in the issue), find the gap, open a ticket to fill it.
- **mention** → reply (skip if the mentioning comment is >2 years old).
- **review request** → `/code-review`, post findings.

Idempotent by its own signature: every action (ack, reply, review, ticket) leaves
a signed comment on the thread, so a thread with a ghDuty comment and nothing newer
is "done" — one uniform check for every item type, no local state, no timestamp.

## Prerequisite

```bash
gh auth status >/dev/null 2>&1 && echo OK || echo "run: gh auth login"
```

## Step 0 — bootstrap (pure configuration, no run-state)

Bootstrap only checks **configuration** — there is no per-run state to read or
write (idempotency lives in the GitHub thread signatures, Step 3). Two config
items:

- **`GHDUTY_WORK_DIR`** — the working folder where repos are cloned (below).
- **`GHDUTY_SLACK_WEBHOOK`** — optional Slack callback for ticket notifications
  (Step 5); unset = Slack silently skipped.

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

There is **no first-run marker and no local state** — the signature in each
thread (Step 3) is the only record of what's been done, so every run behaves the
same: handle every unsigned item in the queue.

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

## Step 2 — (nothing to pick)

Every run handles every item in the queue that isn't already signed or filtered
out (stale >2yr mention, closed PR, etc.). No first-run gate, no checkbox — the
signature is what stops re-handling, and the durable queries + filters are what
scope the work. Built to run unattended.

## Step 3 — fan out: one subagent per item (parallel)

Spawn **one subagent per queue item** with the `Agent` tool, launched in parallel
(multiple `Agent` calls in one message). Each returns
`{repo, number, action: replied|ticketed|reviewed|skipped, ticket_path?, note}`.
The orchestrator collects results for Steps 4–5. **Dedupe target repos and clone
each unique one once before fan-out** (Step 4) — concurrent clones of the same
repo clash; separate `/ticket` writes into an existing clone are safe.

Each subagent must have the `workaholic` and `code-review` skills available (it
runs `/ticket` / `/code-review`) and does all remote writes through the **GitHub
MCP** (branch, file commit, comment) — never `git push` / `gh` write commands,
which permission policy often blocks.

### What each per-item subagent does

1. **Read** the thread and its latest activity:
   ```bash
   gh issue view <number> -R <owner/repo> --comments   # Issue
   gh pr view    <number> -R <owner/repo> --comments   # PullRequest
   ```
2. **Idempotency check — the ghDuty signature in the thread, for every item type.**
   Every action ghDuty takes (ack, reply, review findings, *and* filing a ticket)
   ends by posting a **signed comment on the issue/PR**. So "have I acted on this?"
   is answered uniformly: does the thread already contain a comment with the ghDuty
   signature (`auto-posted by sn0wm1ku/ghDuty`) and **no newer comment after it**?
   If yes → return `skipped`.

   Do **not** rely on finding the ticket file locally: the ticket is pushed to a
   remote `ghduty/ticket-*` branch, never checked out into the clone's working
   tree, so a local `.workaholic/tickets/` grep won't see it — the signed comment
   is the durable, remote marker instead. A thread becomes actionable again only
   when someone comments after ghDuty's signed comment (i.e. real follow-up).
3. **Classify** (table below) and **handle** per Step 4, signed.
4. **Return** the structured result.

Action is driven by **which query surfaced the item** and, for assigned items,
its subtype. An item can be in more than one query; do all that apply.

| Source / signal | Handle it by |
|---|---|
| **assigned ISSUE with a linked PR** (the osbr repos auto-open a PR when you're assigned; you're already assigned on that PR) | Leave an **acknowledgment comment** on the issue: `Acknowledged <UTC date time>.` (signed). The linked PR is handled by the assigned-PR rule below. |
| **assigned ISSUE with no PR** (usually an idea/discussion — still needs a response) | Open a **ticket** in the repo's clone, **create + push a new branch** for the ticket, then **Slack** to drive it (Step 5). |
| **assigned PR** | **Closed → skip.** **Open → gap-fill:** read the PR diff *and its linked issue* — the objective/to-do usually lives in the issue, not the PR. Identify what the issue asks that the PR hasn't done yet, and open a **ticket** (clone + pushed branch + Slack, same as an idea-issue) describing the gap to fill. If the PR already fully satisfies the issue, leave a signed ack comment instead. |
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

1. **Isolate in a git worktree, then run `/ticket` there.** The subagent `cd`s
   into the repo clone and creates a dedicated worktree + branch for this ticket,
   so parallel subagents on the same repo never collide. It runs the workaholic
   `/ticket` skill inside the worktree (so it explores that repo's real code and
   produces a real ticket, not a hand-written stub):

   ```bash
   WORK="${GHDUTY_WORK_DIR:-$HOME/Projects}"
   CLONE="$WORK/<owner>/<repo>"
   [ -d "$CLONE/.git" ] || gh repo clone "<owner>/<repo>" "$CLONE" || echo "clone failed"
   cd "$CLONE"
   git fetch -q origin
   WT="$CLONE/.git/ghduty-wt/t<issue#>"
   git worktree add --detach "$WT" origin/HEAD   # --detach: no local branch (see note)
   cd "$WT"
   # invoke the workaholic /ticket skill here with a concise description of the issue.
   ```

   **Do NOT create a named local branch for the worktree** (`-b ghduty/...`):
   workaholic ships a `guard-git-branch.sh` hook that only allows `work-*` branch
   names, so a custom branch name is rejected. Use `--detach` — the worktree is
   just a scratch dir for `/ticket`; the *remote* branch is made separately via MCP
   (which doesn't hit the local hook).

   **Let `/ticket` own the ticket's path and frontmatter — don't override them.**
   workaholic's `validate-ticket.sh` enforces: path `todo/<user>/<file>.md` (the
   per-user subdir is mandatory; a flat `todo/xyz.md` is rejected), and frontmatter
   `type` ∈ {enhancement,bugfix,refactoring,housekeeping}, `layer` a YAML array of
   {UX,Domain,Infrastructure,DB,Config}, `effort` ≤ 4h. After `/ticket` writes the
   file, add one extra frontmatter line `source: owner/repo#n` (the validator
   ignores unknown fields) so Step 3 idempotency can find it — put the real
   effort/scope in the body if it exceeds 4h.

2. **Push via the GitHub MCP, NOT `git push`.** Raw `git push` (and `gh api` POST)
   are commonly blocked by permission policy; the GitHub MCP tools are the reliable
   path. Read the file `/ticket` produced (at its canonical `todo/<user>/…` path),
   then:
   - `mcp__plugin_github_github__create_branch` — branch `ghduty/ticket-<issue#>-<slug>` from the default branch (remote name, not subject to the local branch hook).
   - `mcp__plugin_github_github__create_or_update_file` — commit the ticket **at the same canonical path** `.workaholic/tickets/todo/<user>/<file>.md` (so the target repo's `/drive` finds it), raw content.

3. **Clean up the worktree**: `git worktree remove --force "$WT"` (the ticket now
   lives on the remote branch via the MCP push).

4. **Post a signed comment on the source issue** (via `add_issue_comment`) noting
   the ticket was filed and the branch name. **This comment is mandatory** — it's
   what Step 3 idempotency keys on, so a ticket without its signed comment would be
   re-filed next run. Format: `Acknowledged <local time>. Filed a ticket — branch \`ghduty/ticket-…\`, queued for /drive.` + signature.

If the clone or MCP push fails, note it in the summary instead of losing the item.
Record `{repo, issue, ticket_path, branch}` for the Slack step.

**Posting comments — use the GitHub MCP** (`mcp__plugin_github_github__add_issue_comment`),
not `gh issue comment`/`git`, for the same permission-policy reason as pushing.
Stamp times in **local time with a timezone label** (friendlier than UTC; get it
with `date '+%Y-%m-%d %H:%M %Z'` → e.g. `2026-07-02 16:55 JST`).

**Acknowledgment comment** (assigned issue that already has a linked PR) — no
ticket, no branch, just:
`Acknowledged <local time>. Assigned — tracked via PR #<pr>.` + signature.

**Every comment the plugin posts must end with this signature** (append it to the
`body` you pass to `add_issue_comment`) — it credits the plugin and the Claude
model, makes comments easy to find/delete, and is what the Step 3 idempotency
check keys on. Fill `<model>` with the model you're running as:

```
<reply body>

---
<sub>🤖 auto-posted by [sn0wm1ku/ghDuty](https://github.com/sn0wm1ku/ghDuty) · co-authored by Claude (claude-opus-4-8)</sub>
```

Post it with `mcp__plugin_github_github__add_issue_comment` (works for issues and
PRs — pass the PR number as `issue_number`). Act only on repos you own or
collaborate on; otherwise note it in the summary instead of posting.

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

## Step 6 — report

Once all subagents have returned, report a short summary: replied / ticketed /
reviewed / skipped-already-answered / skipped-not-mine / notified. No state to
write — the signatures posted this run are the only record.

## Notes

- **Idempotency is the signed comment in the thread** — not a timestamp, not
  notification read-state, not a local ticket file. Every action (including
  filing a ticket) leaves a signed comment, so the same check covers all types.
  Don't look for the ticket locally: it lives on a remote `ghduty/ticket-*` branch
  that's never checked out into the clone.
- Durable queries catch assigned work and review requests that the notification
  inbox drops once read; the tradeoff is one thread read per item to check the
  signature. Fine for a scheduled agent.
- `/ticket` writes the ticket; driving it is a later `/drive` step (both from the
  required `workaholic` plugin). For `/code-review`, point it at the PR's diff.
