---
name: gh-mentions
description: 'Automated agent that finds the GitHub work actually waiting on you across all repos — PRs awaiting your review, issues/PRs assigned to you, and issues/PRs that @-mention you — and handles each on its own, in parallel: replies to questions, runs /ticket on change requests, runs /code-review on review requests, Slack-notifies on tickets created. Uses durable state queries (not the ephemeral notification inbox, which drops assigned/read items); idempotent by its own reply signature. Use when the user says "check my GitHub mentions", "handle my mentions", "work my GitHub queue", or runs this on a schedule.'
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

Bootstrap checks **configuration**. Correctness never depends on local state —
"acted" is recorded remotely by the thread signature (Step 3). There is one
**local optimization cache** (the skip-ledger, below): losing it only costs a
re-read, never a wrong action.

- **`GHDUTY_WORK_DIR`** — the working folder where repos are cloned (below).
- **`GHDUTY_SLACK_WEBHOOK`** — optional Slack callback for ticket notifications
  (Step 5); unset = Slack silently skipped. **First-run permission gate — when it
  IS set, actively check the user has granted the webhook POST**, because with
  `defaultMode: auto` Claude Code's classifier blocks external writes and the agent
  **cannot self-grant** (self-modification guard). Check whether the grant is
  already present:

  ```bash
  grep -rqs 'ghduty.*Slack\|Slack.*webhook.*ghduty\|hooks.slack.com' \
    ~/.claude/settings.json ~/.claude/settings.local.json 2>/dev/null \
    && echo "slack grant: present" || echo "slack grant: MISSING — prompt user"
  ```

  If MISSING, **`AskUserQuestion`** the user to add the one-time `autoMode.allow`
  grant (exact snippet in README "Slack setup") before the run — they paste it into
  settings, or accept that Step 5 will be blocked and they'll send it themselves.
  Don't silently proceed to a Step 5 that will just get denied.
- **skip-ledger** — a **cache** (not config): a directory
  `${CLAUDE_PLUGIN_DATA:-$HOME/.claude/ghduty}/skip-ledger/` with **one file per
  thread**, `<owner>__<repo>__<n>.json` holding `{"updatedAt": "…"}`. One file per
  key means the parallel workers in Step 3 each write **only their own** file — no
  shared-file write race, no lock, and it's self-compacting (one file per live
  thread; the latest write overwrites, and a closed thread's file can be deleted).
  Safe to delete wholesale (just forces a re-read). Kept separate from the plugin's
  durable config list (`extra-repos.txt`, managed by `manage-repos`) — config vs
  cache are different kinds. Details in Step 3.

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

There is **no first-run marker** — every run behaves the same. The only local
file is the skip-ledger (an optimization cache, above); correctness lives in the
remote thread signatures.

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

## Step 3 — run the bundled workflow (deterministic; do NOT hand-author a fan-out)

**Invoke the committed workflow script — do not re-improvise the orchestration.**
The full flow (discover + dedupe + **ledger fast-skip** + one agent per item +
Slack notify) lives in one script so no step is ever dropped:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/gh-mentions.js" })
```

That is the single source of truth for execution. It fans out via `parallel()`
(concurrency auto-capped at `min(16, cores−2)`), each item handled by its own
`general-purpose` agent that does all remote writes through the **GitHub MCP**
(never `git push`/`gh` write), applies the ledger fast-skip **and** records
no-action items, auto-approves LGTM reviews, and sends the Step 5 Slack notice in
the canonical format. **Never** substitute an ad-hoc `Agent` fan-out or a
hand-written workflow — that is exactly how the ledger fast-skip and Slack step got
dropped before, re-creating already-ledgered tickets.

The sections below **document what the script does** (per-item classification,
idempotency, ledger, signature) — they are the spec the script implements, not a
second thing to run by hand.

- The skip-ledger is **one-file-per-key**, so the script's parallel agents each
  write only their own `<owner>__<repo>__<n>.json` (atomic temp+rename) — no
  shared-file race, no lock.

**Ledger fast-skip (orchestrator, before fan-out).** For each queue item, read its
per-key file `skip-ledger/<owner>__<repo>__<n>.json`: if it exists with the **same
`updatedAt`** the query returned (no new activity since you last judged it not worth
acting on), drop it from the work set — no agent, no thread read. If the file is
missing or its `updatedAt` differs (new activity), the item goes into `items` for
the parallel stage. This is what stops "considered, no action" items from being
re-read every run; the signature (remote) still covers items you *did* act on.

```bash
DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/ghduty}"; LED="$DIR/skip-ledger"; mkdir -p "$LED"
key(){ echo "$LED/$(echo "$1" | tr '/#' '__').json"; }   # owner/repo#n -> file
# ONE-TIME MIGRATION: an older ghDuty used a single-file ledger (skip-ledger.jsonl).
# Fold it into per-key files so its entries are still honored, then retire it —
# otherwise the format change silently orphans every previously-ledgered item.
if [ -f "$DIR/skip-ledger.jsonl" ]; then
  jq -c '.' "$DIR/skip-ledger.jsonl" | while IFS= read -r l; do
    r=$(echo "$l" | jq -r '.repo'); n=$(echo "$l" | jq -r '.number')
    [ -n "$r" ] && [ "$r" != null ] && echo "$l" > "$(key "$r#$n")"
  done
  mv "$DIR/skip-ledger.jsonl" "$DIR/skip-ledger.jsonl.migrated"
fi
```

**The ledger fast-skip is MANDATORY every run — never bypass it.** (A hand-authored
run that skips it re-processes everything the last run judged "no action", which is
how already-ledgered items like stale `tabisugo` tickets get re-created. Run the
skill's flow; don't improvise a fan-out that drops this step.)

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
4. **Return** the structured result, and — if the verdict is **no action needed**
   (nothing actionable — a bare FYI, an ack, a resolved thread) — **record it in the
   agent itself** by writing its own per-key ledger file (parallel-safe: distinct
   path per key, atomic temp + rename):
   ```bash
   f="$(key "<owner>/<repo>#<n>")"; tmp="$(mktemp)"
   jq -n --arg u "<updatedAt>" '{updatedAt:$u}' > "$tmp" && mv "$tmp" "$f"
   ```
   so the fast-skip suppresses it next run until new activity bumps `updatedAt`.
   Items that were *acted on* are NOT ledgered — their signed comment is the marker.
   (Because each agent writes only its own key's file, parallel workers never race —
   no shared-file append, no lock.)

Action is driven by **which query surfaced the item** and, for assigned items,
its subtype. An item can be in more than one query; do all that apply.

| Source / signal | Handle it by |
|---|---|
| **assigned ISSUE with a linked PR** (the osbr repos auto-open a PR when you're assigned; you're already assigned on that PR) | Leave an **acknowledgment comment** on the issue: `Acknowledged <UTC date time>.` (signed). The linked PR is handled by the assigned-PR rule below. |
| **assigned ISSUE with no PR** (usually an idea/discussion — still needs a response) | Open a **ticket** in the repo's clone, **create + push a new branch** for the ticket, then **Slack** to drive it (Step 5). |
| **assigned PR** | **Closed → skip.** **Open → gap-fill:** read the PR diff *and its linked issue* — the objective/to-do usually lives in the issue, not the PR. Identify what the issue asks that the PR hasn't done yet, and open a **ticket** (clone + pushed branch + Slack, same as an idea-issue) describing the gap to fill. **If the work is already fully shipped / no gap remains, don't ticket** — leave a signed comment stating it looks shipped (cite the evidence) and **suggesting the issue/PR be closed**. |
| **review-requested**, or a comment asking for review | Run `/code-review` on that PR and post the findings as a reply. **If the verdict is LGTM (no blocking findings), also submit an actual PR approval** — `mcp__plugin_github_github__pull_request_review_write` (method `create`, event `APPROVE`) — not just a comment; a requested review isn't cleared until it's approved (or changes requested). If there ARE blocking findings, request changes / comment instead of approving. |
| **mentioned**, and the mention asks something | Reply — answer a question, or ticket + reply if it's a change request. **Skip if the mentioning comment itself is >2 years old** (judge by the comment's `created_at`, not the issue's; a stale @ isn't worth answering). |
| Genuinely nothing to do (pure FYI, an ack, already resolved) | Skip. |

Age note: the 2-year cutoff applies **only** to the mention line. Assigned items
and review requests are handled regardless of age (an assigned task still needs
doing; a review is still requested).

Already-shipped note: whenever handling reveals the work is **already done and
merged** (verified in code), don't file a ticket — post a signed comment citing
the evidence and **suggesting the issue/PR be closed**. That comment is also the
signature marker, so the item won't be re-processed next run.

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

   **cwd caveat (observed):** a subagent's bash cwd may not stay pinned to `$WT`
   across calls, so invoking `/ticket` can run against the wrong dir. If you can't
   reliably keep cwd in the worktree, do the code exploration yourself and
   **hand-author the ticket in workaholic's exact format** (frontmatter enums +
   `todo/<user>/<ts>-*.md` path) — the file is what matters, not the skill call.

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
notified.

**Canonical message format — the committed workflow builds this; don't improvise.**
**List every handled item, item-by-item, NEVER collapsed into a tally** — grouped by
action, and **every item is a clickable Slack link** (`<url|owner/repo#n>`) to its
issue/PR (ticket branches link too, `<…/tree/branch|branch>`):

```
:robot_face: *ghDuty run* — <N> items handled (+<M> ledger fast-skipped)

*:ticket: Tickets created (K):*
• <https://github.com/owner/repo/pull/12|owner/repo#12> — <title>
  branch <https://github.com/owner/repo/tree/ghduty/ticket-…|ghduty/ticket-…> · run `/drive`

*:mag: Reviewed (K):*  /  *:white_check_mark: Approved (K):*
• <url|owner/repo#n> — <one-line>

*:memo: Acknowledged (K):*  /  *:speech_balloon: Replied (K):*  /  *:fast_forward: Already signed (K):*  /  *:white_circle: No action (K):*  /  *:hourglass: Stale (K):*  /  *:no_entry: Not my repo (K):*
• <url|owner/repo#n>
```

Every action group that has ≥1 item is printed with **all** its items listed — no
`(also: 1 review, 10 acks…)` collapsing. Then POST:

```bash
if [ -n "$GHDUTY_SLACK_WEBHOOK" ]; then   # and ≥1 ticket created
  curl -sS -X POST -H 'Content-type: application/json' \
    --data "$(jq -n --arg t "$MSG" '{text:$t}')" "$GHDUTY_SLACK_WEBHOOK" >/dev/null
fi
```

If unset or no ticket was created, skip silently. **If the POST is denied by the
auto-mode classifier** (external-write block, when the user hasn't added the
`autoMode.allow` grant from README "Slack setup"), don't treat it as failure of the
run — the tickets are already filed. Report in Step 6 that the Slack ping was blocked
for lack of the one-time grant, and print the ready-to-run `curl` (or the grant to
add) so the user can finish it. Never silently drop it.

## Step 6 — report

Once all subagents have returned, report a short summary: replied / ticketed /
reviewed / skipped-already-answered / skipped-not-mine / notified. No state to
write — the signatures posted this run are the only record.

## Notes

- **Two records, by outcome.** *Acted* (ack/reply/review/ticket) → a signed
  comment in the thread (remote, durable, the correctness record). *Considered
  but no action* → a per-thread file in the local skip-ledger directory holding its
  `updatedAt` (an optimization so it isn't re-read every run; safe to delete). New
  activity after either — a comment after our signature, or a bumped `updatedAt`
  past the ledger file — makes the item actionable again. Don't look for a ticket
  file locally: it lives on a remote `ghduty/ticket-*` branch, never checked out
  into the clone.
- Durable queries catch assigned work and review requests that the notification
  inbox drops once read; the tradeoff is one thread read per item to check the
  signature. Fine for a scheduled agent.
- `/ticket` writes the ticket; driving it is a later `/drive` step (both from the
  required `workaholic` plugin). For `/code-review`, point it at the PR's diff.
