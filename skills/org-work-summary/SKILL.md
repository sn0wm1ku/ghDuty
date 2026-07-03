---
name: org-work-summary
description: 'Turn a GitHub org''s current-week activity into material a lead can take to upper management: what shipped and its quality, how far in-flight work has progressed and when it will land, what''s stalled or abandoned, and — the point of the report — where the team needs help and what actionable opportunities to pursue next. Pulls org-wide search state (merged/open PRs, opened/closed issues, commits) for the week (last Saturday→today), fans out one read-only schedule-planner subagent per PR to judge it against its linked issue (progress by acceptance criteria for open PRs, objective-satisfaction + done-ness for merged PRs, code review delegated to /code-review), reasons about delivery with Kanban flow metrics (WIP, throughput, Work Item Age) not raw counts, and treats every metric as a team-level signal never an individual rating. Use when the user says "org weekly summary", "what did the team ship this week", "how far along is our work", "prep for my management update", or runs it on a Friday schedule.'
---

# Org weekly work summary

A read-only reporting agent. Given a GitHub org, it collects **this week's**
activity across every repo and writes a delivery report. No writes, no tickets,
no comments — just a report.

## Purpose (this drives every choice below)

The report exists to:

1. **Give a lead material to talk to upper management** — concrete, defensible,
   presentable.
2. **Grasp the team's real progress** — what shipped, how far in-flight work is,
   what's stuck.
3. **Surface what assistance the team needs** — where it's blocked, under-owned,
   overloaded, or accumulating debt.
4. **Discover actionable opportunities** — the report ends with concrete next
   actions, not just a description of the week.

**Write for a reader who is NOT an experienced manager.** Assume the reader does
not know what a leader is "supposed" to do with this data. So the report never
just presents a number and stops — for every signal it (a) says **what it means**
in one plain sentence, (b) says **what a lead typically does** about it, and
(c) where useful, gives a **ready-to-use talking point** for the management
conversation. Briefly define any metric term inline the first time (e.g. "WIP =
items started but not finished"). The report should be able to stand in for the
leadership experience the reader doesn't yet have.

The section layout below is **one way to organize the evidence toward those
goals, not a rigid schema** — reorganize, merge, or drop sections to serve the
purpose. What is *not* negotiable is the **metric discipline** (grounded in Kanban
flow metrics, DORA, and engineering-management practice) that keeps the report
honest — see "Metric discipline" before writing.

"This week" = **last Saturday through today** (assumed to end on a Friday; the
range is computed, not hard-coded).

## Prerequisite

```bash
gh auth status >/dev/null 2>&1 && echo OK || echo "run: gh auth login"
```

## Step 0 — bootstrap (config only)

- **`GHDUTY_ORG`** — the GitHub org login to summarize. If unset, **ask the user**
  (`AskUserQuestion`) and tell them to persist it in their
  [settings.json](https://code.claude.com/docs/en/settings) `env` block:
  `"env": { "GHDUTY_ORG": "<org>" }`. No run-state, no local files.

```bash
[ -n "$GHDUTY_ORG" ] && echo "org: $GHDUTY_ORG" || echo "GHDUTY_ORG unset — ask the user"
```

## Step 1 — compute the week window

```bash
# BSD date (macOS). GNU date: SINCE=$(date -d "last saturday" +%F) or -d "$OFF days ago".
DOW=$(date +%u)                 # 1=Mon .. 7=Sun
OFF=$(( (DOW + 1) % 7 ))        # days since last Saturday (Sat→0, Sun→1, … Fri→6)
SINCE=$(date -v-${OFF}d +%F)    # last Saturday
UNTIL=$(date +%F)               # today
echo "week: $SINCE .. $UNTIL"
```

## Step 2 — collect the org's activity (durable org-wide search)

Each query is scoped by `--owner=$GHDUTY_ORG`, so one query covers **every repo in
the org**. The week-scoped queries give this week's *throughput* (finished work);
the open-state queries give current *WIP* (work in progress) — both are needed to
reason about flow (Step 3 forecasting, Step 4 metrics).

```bash
# THROUGHPUT — finished this week
# PRs merged this week (the primary "shipped" signal)
gh search prs --owner="$GHDUTY_ORG" --merged --merged-at="$SINCE..$UNTIL" --limit 100 \
  --json repository,number,title,author,url,closedAt   # closedAt == merge time
# PRs closed this week (merged OR abandoned) — subtract the merged set to get abandoned
gh search prs --owner="$GHDUTY_ORG" --state=closed --closed="$SINCE..$UNTIL" --limit 100 \
  --json repository,number,title,author,url,closedAt
# issues closed this week
gh search issues --owner="$GHDUTY_ORG" --closed="$SINCE..$UNTIL" --limit 100 \
  --json repository,number,title,author,url,closedAt
# commits authored this week (work outside PRs)
gh search commits --owner="$GHDUTY_ORG" --author-date="$SINCE..$UNTIL" --limit 100 \
  --json repository,author,commit,sha,url

# WIP — currently open (NOT week-scoped: in-flight work started earlier still counts)
# all open PRs — the active delivery pipeline; createdAt is the Work Item Age proxy
gh search prs --owner="$GHDUTY_ORG" --state=open --limit 200 \
  --json repository,number,title,author,url,createdAt,updatedAt,assignees,isDraft
# all open issues — the pending backlog
gh search issues --owner="$GHDUTY_ORG" --state=open --limit 200 \
  --json repository,number,title,url,assignees,labels,createdAt,updatedAt
```

Derive:
- **Abandoned PRs this week** = closed-this-week set **minus** merged-this-week set
  (by `repo#number`) — PRs closed without merging.
- **PR work-set for Step 3** = merged-this-week ∪ open PRs (dedupe by `repo#number`).
  These are the PRs worth a deep read; abandoned ones just get counted.

If any query hits its `--limit`, **say so in the report** — the counts are a lower
bound, not the truth. Never present a capped number as complete.

> Note: `gh search` JSON can't cheaply tell a "completed" issue from one closed as
> *not planned*, so treat closed issues as completed unless a subagent read reveals
> otherwise, and say the abandoned-issue count is PR-based + best-effort.

## Step 3 — deep-analyze each PR (fan out, parallel)

Spawn **one subagent per PR** in the work-set (`Agent` tool, launched in parallel —
multiple calls in one message), each as the **`schedule-planner`** agent type
(`subagent_type: "schedule-planner"`) — a delivery-progress analyst persona, not
the general-purpose one. It reads the diff *and* the linked issue and judges the
PR against **what it set out to do**, not what its description claims. The persona
file (`agents/schedule-planner.md`) carries the full method; the essentials:

- **Open PR → progress.** Measure "how far / what's left" against the linked
  issue's **acceptance criteria / Definition of Done** — unchecked items are the
  remaining work. When no checklist exists, **infer** and clearly label it as
  inferred (never a fabricated %). Staleness = **Work Item Age** (time since the PR
  opened), not calendar age and not cycle time. Forecast a landing date honestly:
  milestone if set, else a throughput-based range, else "no reliable estimate".
- **Merged PR → quality.** Two axes: did it satisfy the objective, and is it truly
  done (tested, release-ready)? Deferred tests/refactors → name them as **visible
  follow-up debt** for the plan. For code-quality depth, the persona **delegates to
  the `/code-review` skill / code-reviewer expert** and folds findings into plan
  terms — it does not hand-roll a review.
- **Never** judge progress or output by commit count / lines-of-code / diff size —
  those are Goodhart-prone and penalize refactoring. Every subagent is read-only.

Each returns the structured JSON in the persona spec (objective + source, progress
criteria, Work Item Age, ETA, satisfies-objective, release-ready, follow-up debt,
`one_line`). The orchestrator collects these for Step 4.

## Metric discipline (non-negotiable — read before writing Step 4)

Grounded in Kanban flow metrics, DORA, and engineering-management practice:

- **Flow, not volume.** Reason with **WIP** (open items = started-not-finished),
  **Throughput** (items finished this week), and **Work Item Age** (age of open
  items). By **Little's Law** (`Cycle Time ≈ WIP ÷ Throughput`) these are coupled —
  rising WIP with flat throughput means longer completion times; that is a finding.
- **Commit/PR/LOC counts are context, never a scoreboard.** Report the
  per-contributor commit tally as *coordination* context (who touched what),
  **explicitly not a productivity ranking**. LOC and commit counts are invalid
  productivity measures (they penalize refactoring; LOC isn't comparable across
  languages) — say so if anyone might read them that way.
- **Team-level signals, never individual ratings.** Every metric is a cooperative
  signal for improvement, never a target/OKR and never a person's performance
  grade. Do not rank people.
- **Both speed and stability.** If you characterize delivery health, pair
  throughput with a stability read (reverts, reopened issues, follow-up-debt
  volume) — not speed alone. Note that **merge ≠ deploy**, so any DORA-style read
  is an approximation from PR/issue data; label it as such.
- **No fabricated precision.** No made-up % done, no invented ETA. Ranges and
  "unknown" are honest; false precision is a vanity metric.

## Step 4 — write the report

Organize the evidence toward the four purposes. A workable layout:

1. **Headline** — one line: `<org> · <SINCE>..<UNTIL> — <N> shipped, <O> in flight,
   <A> abandoned, <B> pending; <K> people active`.
2. **Shipped (planned work done) + quality** — merged PRs / closed issues grouped
   by repo or theme, each with the subagent's `one_line` and a quality tag
   (✓ done & release-ready / ⚠ carries follow-up debt — name the debt). This is the
   "what got delivered and is it solid" the management update leads with.
3. **In flight + when it lands** — open PRs/active issues with progress
   (`≈4 of 6 criteria, inferred`), **Work Item Age**, and the **honest ETA**
   (milestone / throughput-range / none). Flag **stalled** items (old Work Item Age,
   little progress).
4. **Abandoned / at risk** — PRs closed unmerged this week, plus open items that are
   dead-stale (high Work Item Age, no recent activity) and *not* deliberately parked.
5. **Pending backlog** — open issues classified: **active-assigned** (owned, moving),
   **active-unassigned** (open work with no owner — a coordination risk to flag),
   **iceboxed** (deliberately parked: a parked label — `icebox`/`backlog`/`on-hold`/
   `blocked`/`wontfix`/`someday`/`deferred`, case-insensitive — or no update in 90+
   days).
   <!-- ponytail: label-set + 90d staleness are tunable defaults; make them config if a repo's conventions differ -->
6. **Per-repo activity** — commits-by-contributor tally and WIP/throughput per repo,
   framed per the metric discipline (coordination context, **not** a ranking).
7. **What the team needs (assistance)** — synthesize from the signals, and for each
   one **explain it for a non-manager**: the signal, what it means, and what a lead
   usually does. Common patterns and the standard leader response:
   - *Active work with no assignee* → nobody owns it; work with no owner tends to
     stall. **Do:** assign an owner or drop it.
   - *A PR open a long time with no review* → it's blocked waiting on people, not
     code. **Do:** find a reviewer / raise it in standup.
   - *WIP above ~team size* (WIP = items started-not-finished) → too many things
     started at once, so everything finishes slower (Little's Law). **Do:** get the
     team to finish before starting new work.
   - *One person authoring most of a repo* → bus-factor risk; the team depends on one
     person. **Do:** pair someone in / spread reviews.
   - *Follow-up debt piling up* (deferred tests/refactors from merged work) → quietly
     slows future work. **Do:** schedule it as real backlog items now.
8. **Actionable opportunities** — the payoff. A short, **prioritized** list of
   concrete next actions, each written so an inexperienced lead can just do it:
   *what to do, which item (#link), why it matters, and — where relevant — a
   one-sentence talking point for management* (e.g. "We shipped X and Y this week;
   Z is ~1–2 weeks out; our main risk is three unowned tasks I'm assigning
   Monday."). Rank by impact. End here — this is what the reader acts on.

Every claim traces to a diff, issue criterion, PR, commit, or flow metric in the
data — no speculation beyond what the evidence shows. And every finding a
non-manager reads should leave them knowing what it means and what to do next.

## Notes

- **Read-only.** Posts nothing, writes no local state — unlike `gh-mentions` there
  is no signature or ledger; re-running just re-reads the week.
- **Two granularities.** Org-wide `gh search` (Step 2) scopes the *list* in one
  query per category. The *depth* (Step 3) fans out one **`schedule-planner`**
  subagent per PR (a delivery-progress persona shipped with this plugin, not
  general-purpose); many PRs means many subagents, and a busy org may cap at
  `--limit` (surfaced in Step 2).
- **Division of labor.** The schedule-planner owns *progress, fit, and schedule*
  judgment. Actual code review stays with `/code-review` and its expert.
- **The report is diagnostic, not a scoreboard.** Its job is to inform planning and
  surface where to help — metrics are team-level improvement signals, never
  individual performance ratings (see Metric discipline).
- Date math is BSD `date` (macOS); the inline comment gives the GNU equivalent.
