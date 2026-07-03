---
name: org-work-summary
description: 'Summarize a GitHub org''s work for the current week (last Saturday through today), across all repos: what shipped and who contributed. Pulls durable org-wide search state (merged/opened PRs, closed/opened issues, commits) scoped to the week, then writes a narrative summary grouped by theme and a per-contributor breakdown. Use when the user says "org weekly summary", "what did the org ship this week", "who worked on what this week", or runs it on a Friday schedule.'
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
```

If any query hits the 100-item `--limit`, note in the report that results were
capped for that category (the org was busier than one page) — don't silently
undercount.

## Step 3 — synthesize the summary

From the collected JSON, write a report with two parts:

1. **What got done** — group merged PRs + closed issues by repo (or by theme when
   several PRs across repos are clearly one effort). One line each: what it did,
   its `repo#number` link. Lead with merged/closed (shipped); list notable open
   PRs/issues after as "in flight".
2. **Who contributed** — a per-person breakdown keyed on `author.login` (union of
   PR authors, issue authors, and commit authors). For each contributor: count of
   merged PRs / closed issues / commits, and a one-line description of their main
   thread of work that week. Sort by volume of shipped work.

Keep it tight and factual — every claim traces to a PR/issue/commit in the data.
Open with a one-line headline (`<org>: <N> PRs merged, <M> issues closed, <K>
contributors, <SINCE>..<UNTIL>`).

## Notes

- **Read-only.** This skill posts nothing and writes no local state — unlike
  `gh-mentions`, there's no signature or ledger because there's no action to be
  idempotent about. Re-running just re-reads the week.
- **Org-wide in one query.** `--owner` scopes each search to the whole org, so no
  per-repo fan-out is needed; a busy org may cap at `--limit`, surfaced in Step 2.
- Date math is BSD `date` (macOS); the inline comment gives the GNU `date`
  equivalent for Linux schedules.
