---
name: org-work-summary
description: 'Summarize a GitHub org''s work for the current week (last Saturday through today), across all repos: what shipped, how far in-flight work has progressed, and who contributed. Pulls org-wide search state (merged/opened PRs, closed/opened issues, commits) scoped to the week, then fans out one read-only subagent per PR to read its DIFF and linked issue — for open PRs it gauges progress against the objective (how much implemented, how far to go), for merged PRs it judges quality (what was done well, room for improvement). Also gives a per-repo issue status (completed this week vs pending — pending split into active-assigned, active-unassigned, iceboxed) and per-repo commit counts grouped by contributor. Writes a themed summary plus a per-contributor breakdown. Use when the user says "org weekly summary", "what did the org ship this week", "how far along is our work", "who worked on what this week", or runs it on a Friday schedule.'
---

# Org weekly work summary

A read-only reporting agent. Given a GitHub org, it collects **this week's**
activity across every repo in the org and writes a summary of the work done and
who contributed. No writes, no tickets, no comments — just a report.

"This week" = **last Saturday through today** (the week is assumed to end on a
Friday; the range is computed, not hard-coded).

## Prerequisite

```bash
gh auth status >/dev/null 2>&1 && echo OK || echo "run: gh auth login"
```

## Step 0 — bootstrap (config only)

One piece of configuration: **which org**.

- **`GHDUTY_ORG`** — the GitHub org login to summarize. If unset, **ask the user**
  (`AskUserQuestion`) and tell them to persist it in their
  [settings.json](https://code.claude.com/docs/en/settings) `env` block:
  `"env": { "GHDUTY_ORG": "<org>" }`. No run-state, no local files.

```bash
[ -n "$GHDUTY_ORG" ] && echo "org: $GHDUTY_ORG" || echo "GHDUTY_ORG unset — ask the user"
```

## Step 1 — compute the week window

Today is assumed to be **Friday**; the week runs from the most recent Saturday
through today (inclusive). Compute it, don't hard-code — it works any day:

```bash
# BSD date (macOS). GNU date: SINCE=$(date -d "last saturday" +%F) or -d "$OFF days ago".
DOW=$(date +%u)                 # 1=Mon .. 7=Sun
OFF=$(( (DOW + 1) % 7 ))        # days since last Saturday (Sat→0, Sun→1, … Fri→6)
SINCE=$(date -v-${OFF}d +%F)    # last Saturday
UNTIL=$(date +%F)               # today
echo "week: $SINCE .. $UNTIL"
```

## Step 2 — collect the org's activity (durable org-wide search)

Each query is scoped by `--owner=$GHDUTY_ORG` and the week window, so one query
covers **every repo in the org**. Merged PRs and closed issues are the "work
done" signal; opened PRs/issues are in-flight context; commits catch work that
didn't route through a PR.

```bash
# PRs merged this week — the primary "shipped" signal
gh search prs --owner="$GHDUTY_ORG" --merged --merged-at="$SINCE..$UNTIL" --limit 100 \
  --json repository,number,title,author,url,closedAt   # closedAt == merge time for a merged PR
# PRs opened this week (in-flight)
gh search prs --owner="$GHDUTY_ORG" --created="$SINCE..$UNTIL" --limit 100 \
  --json repository,number,title,author,url,state,createdAt
# issues closed this week
gh search issues --owner="$GHDUTY_ORG" --closed="$SINCE..$UNTIL" --limit 100 \
  --json repository,number,title,author,url,closedAt
# issues opened this week
gh search issues --owner="$GHDUTY_ORG" --created="$SINCE..$UNTIL" --limit 100 \
  --json repository,number,title,author,url,createdAt
# commits authored this week (catches work outside PRs)
gh search commits --owner="$GHDUTY_ORG" --author-date="$SINCE..$UNTIL" --limit 100 \
  --json repository,author,commit,sha,url
# ALL open issues in the org (NOT week-scoped) — the current pending backlog, for
# the per-repo status breakdown in Step 4. --include-prs is omitted so PRs don't count.
gh search issues --owner="$GHDUTY_ORG" --state=open --limit 200 \
  --json repository,number,title,url,assignees,labels,updatedAt
```

If any query hits the 100-item `--limit`, note in the report that results were
capped for that category (the org was busier than one page) — don't silently
undercount.

Dedupe PRs across the merged and opened queries by `repo#number` into one PR
work-set (a PR can be both opened and merged this week). This set is the input to
the deep analysis in Step 3. Issues and commits feed the contributor stats
directly — they don't need deep analysis.

## Step 3 — deep-analyze each PR (fan out, parallel)

Titles and descriptions lie or omit; the **diff** is the ground truth. Spawn
**one subagent per PR** in the work-set (`Agent` tool, launched in parallel —
multiple calls in one message), each as the **`schedule-planner`** agent type
(`subagent_type: "schedule-planner"`) — a delivery-progress analyst persona, not
the general-purpose one. It reads the diff *and* the linked issue and judges the
PR against **what it set out to do**, not what its description claims.

For a **merged** PR's quality verdict, the schedule-planner delegates the actual
code review to the **`/code-review` skill / code-reviewer expert** and folds those
findings back into the objective/schedule view — the persona does not hand-roll a
code review. Keep every subagent read-only (`gh` reads + `/code-review`, which
also only reads — never a write). Each returns the structured verdict below.

### What each per-PR subagent does

1. **Read the PR and its diff:**
   ```bash
   gh pr view <n> -R <owner/repo> \
     --json number,title,state,body,author,additions,deletions,changedFiles,closingIssuesReferences,comments
   gh pr diff <n> -R <owner/repo>          # the actual changes — the ground truth
   ```
2. **Find the objective.** The to-do usually lives in the **linked issue**, not
   the PR. Take `closingIssuesReferences`; if empty, scan the PR body for
   `Closes/Fixes/Resolves #<n>` and any task checklist (`- [ ]` / `- [x]`). Read
   the linked issue for the real acceptance criteria:
   ```bash
   gh issue view <issue#> -R <owner/repo> --json title,body
   ```
3. **Judge by state:**
   - **Open / not merged (incomplete)** → gauge **progress**. Break the objective
     into concrete requirements (issue acceptance criteria + PR checklist items),
     then check each against the diff: **implemented / partial / not started**.
     Report a fraction (`4/6 done`), what's **left to go**, and any blockers or
     TODO/`FIXME`/stub markers left in the diff.
   - **Merged (complete)** → assess **quality** by running the **`/code-review`
     skill** on the PR (the code-reviewer expert finds the correctness bugs,
     missing tests, silent failures, etc. — don't hand-roll it). Fold its findings
     into an objective-level verdict: what's **done well** and **room for
     improvement** / follow-up debt for next week's plan. Ground every point in a
     file/hunk from the diff or a code-review finding.
4. **Return** `{repo, number, author, state, objective, verdict: progress|quality,
   fraction_done?, remaining?, strengths?, improvements?, one_line}` — `one_line`
   is a single-sentence takeaway for the summary.

Keep each verdict evidence-bound: cite the file/line or issue criterion behind
every claim. If a PR has **no** linked issue and an empty body, judge the diff on
its own terms (what it changes, whether it looks coherent and complete) and say
the objective was inferred from the diff.

## Step 4 — synthesize the summary

From the collected JSON (Step 2) and the per-PR verdicts (Step 3), write:

1. **Headline** — `<org>: <N> PRs merged, <O> open/in-flight, <M> issues closed,
   <K> contributors · <SINCE>..<UNTIL>`.
2. **What shipped** — merged PRs grouped by repo or theme. One line each from the
   subagent's `one_line`, tagged with a quality note (✓ solid / ⚠ has gaps) and
   the top improvement when there is one.
3. **In flight** — open PRs with their **progress** (`4/6 done — remaining: …`),
   so the reader sees how far each is and what's left. Flag stalled ones (open,
   little of the objective done).
4. **Per-repo issue status** — for each repo with activity or open issues, a
   compact breakdown:
   - **Commits this week, by contributor** — from Step 2's commit query, group by
     `repository` then by `author.login`, and show the count per person
     (`alice ×12, bob ×3` — total 15). This is the per-repo commit tally the report
     leads its contributor picture with. (Capped at the commit query's `--limit`;
     if that cap was hit, say the counts are a lower bound.)
   - **Completed this week** — issues closed this week (from Step 2's closed-issue
     query, grouped by repo). List `#n title`.
   - **Pending** — the repo's open issues (from the org-wide open-issues query),
     classified into three buckets:
     - **iceboxed** — parked / not being worked. An issue is iceboxed if it carries
       a parked label (`icebox`, `backlog`, `on-hold`, `blocked`, `wontfix`,
       `someday`, `deferred` — case-insensitive substring match) **or** hasn't been
       updated in 90+ days (`updatedAt` older than `UNTIL − 90d`).
       <!-- ponytail: label-set + 90d staleness heuristic; make the label list / window a config var if a repo's conventions differ -->
     - **active assigned** — not iceboxed, has ≥1 `assignees` entry (someone owns it).
     - **active unassigned** — not iceboxed, no assignee (open work with no owner —
       worth flagging).

     Show counts per bucket and list the active ones (`#n title` + assignee for the
     assigned bucket); iceboxed can be a count with the oldest few, since the point
     is that they're parked.
5. **Who contributed** — per-person breakdown keyed on `author.login` (union of PR
   authors, issue authors, commit authors). For each: counts (merged / open /
   issues closed / commits) and a one-line description of their main thread that
   week, drawing on the PR verdicts. Sort by shipped volume.

Every claim traces to a diff, issue criterion, PR, or commit in the data — no
speculation beyond what the code shows.

## Notes

- **Read-only.** Posts nothing, writes no local state — unlike `gh-mentions` there
  is no signature or ledger, because there is no action to be idempotent about.
  Re-running just re-reads the week.
- **Two granularities.** Org-wide `gh search` (Step 2) scopes the *list* in one
  query per category — no per-repo fan-out for discovery. The *depth* (Step 3)
  fans out one **`schedule-planner`** subagent per PR (a delivery-progress persona
  shipped with this plugin, not general-purpose) to read its diff + linked issue;
  a busy org may cap at `--limit`, surfaced in Step 2, and many PRs means many
  subagents.
- **Division of labor.** The schedule-planner owns *progress and schedule*
  judgment. Actual code review stays with the `/code-review` skill and its expert
  — the planner invokes it for merged-PR quality and translates the findings into
  plan terms, rather than reviewing code itself.
- The diff is the ground truth — a PR's own description is a claim, not a fact.
  Progress and quality verdicts must cite the diff, not the description.
- Date math is BSD `date` (macOS); the inline comment gives the GNU `date`
  equivalent for Linux schedules.
