# ghDuty

**GitHub duty** — a Claude Code plugin that runs as an automated agent whose core
job is to **automate your pending tasks**. It builds a queue from durable GitHub
state across all repos and, in parallel:

- **Assigned issue that already has a linked PR** (the osbr repos auto-open a PR when you're assigned) → leaves a signed acknowledgment comment; the PR is handled by the PR rule.
- **Assigned issue with no PR** (an idea/discussion) → opens a `/ticket` (from [workaholic](https://github.com/qmu/workaholic)) in the target repo's clone, **pushes a ticket branch**, and Slacks you to `/drive` it.
- **Assigned PR** → closed: skipped; open: reads the PR **and its linked issue** (the objective/to-do usually lives in the issue, not the PR), finds the gap, and opens a ticket to fill it (ack comment instead if the PR already satisfies the issue).
- **Mentions you** → replies to every one, unless the mentioning *comment* is >2 years old (judged by the comment's date, not the issue's).
- **Review requested** → runs `/code-review` (from [code-review](https://github.com/anthropics/claude-plugins-official)) against the PR.
- **Tickets created this run** → optionally pings you on Slack (with the pushed branch).

GitHub is the record — every open assigned/mentioned/review item counts,
regardless of branch.

Discovery uses **durable state queries** (`review-requested`, `assignee`,
`mentions` — all open), not the notification inbox, which is ephemeral and drops
assigned work and anything you've already read even if it isn't done. It's
**idempotent by its own reply signature**: a thread stays "done" while it carries
a ghDuty reply with nothing after it, and becomes actionable again when someone
replies after that. No timestamps. Designed to run on a schedule.

## Requirements

- [Claude Code](https://claude.com/claude-code) **v2.1.110+** (needed for plugin dependencies)
- [`gh` CLI](https://cli.github.com/) installed and authenticated (`gh auth login`), with `repo` scope.
- A **working folder** where repos live / get cloned (see below).
- Two other plugins, **auto-installed as dependencies** (see below):
  - `workaholic` — provides `/ticket`, `/drive`, etc.
  - `code-review` — provides `/code-review`

## Install

ghDuty forces its two dependencies, but Claude Code can only auto-install them
if their marketplaces are already added. Add all three marketplaces, then
install:

```bash
# dependency marketplaces (add once)
claude plugin marketplace add qmu/workaholic
claude plugin marketplace add anthropics/claude-plugins-official

# this plugin
claude plugin marketplace add sn0wm1ku/ghDuty
claude plugin install ghduty@ghduty
```

Installing `ghduty` pulls in `workaholic` and `code-review` automatically and
lists them at the end of the install output. If a dependency marketplace isn't
added yet, install reports `dependency-unsatisfied` and tells you exactly which
`claude plugin marketplace add` command to run.

> Disabling `workaholic` or `code-review` while `ghduty` is enabled is blocked —
> Claude Code keeps required dependencies on. Use `claude plugin uninstall ghduty --prune`
> to remove it and clean up dependencies nothing else needs.

## Use

Run it on demand:

```
/gh-mentions
```

### Org weekly summary

A separate read-only skill, `/org-work-summary`, turns a whole org's
**current-week** activity (last Saturday through today — assumed to end on a
Friday, but the range is computed so it works any day) into a delivery report
built for four goals: **material to talk to upper management**, a real **grasp of
team progress**, a read on **what help the team needs**, and — the payoff — a
prioritized list of **actionable opportunities**.

It's **written for a reader who isn't an experienced manager**: every signal comes
with what it *means* in plain words, what a lead typically *does* about it, and
where useful a ready-to-use talking point for the management conversation.

It pulls org-wide search state (merged/open PRs, opened/closed issues, commits)
and **reads each PR's diff and its linked issue** (not just the description) to
judge it against what it set out to do:

- **open PRs** → **progress** by the linked issue's acceptance criteria (not a
  made-up %), staleness by **Work Item Age**, and an **honest ETA** (milestone,
  else a throughput-based range, else "no reliable estimate");
- **merged PRs** → **quality**: did it meet the objective and is it truly done
  (tested/release-ready), with deferred work surfaced as visible follow-up debt.

The per-PR analysis runs as a dedicated **`schedule-planner`** agent persona
(shipped with this plugin) — a delivery-progress analyst, not the general-purpose
agent, grounded in Kanban flow metrics / DORA / engineering-management practice.
It owns *progress and schedule* judgment; the actual code review for merged PRs is
delegated to the `/code-review` skill and its expert, whose findings it folds into
plan terms.

The report covers **what shipped (and its quality)**, **what's in flight (with
progress + ETA)**, **abandoned / at-risk** work, the **pending backlog** (active
assigned / active unassigned / iceboxed), **per-repo activity**, **what the team
needs**, and **actionable opportunities**. Every metric is treated as a
team-level signal — never an individual performance ranking (no scoring by commit
or line counts). It posts nothing and keeps no state — just a report.

Set the org via `GHDUTY_ORG` in your settings `env` block (it asks if unset):

```json
{ "env": { "GHDUTY_ORG": "your-org" } }
```

Teams often work in repos **outside** the org (a parent company's org, a personal
fork), which an org-only search misses — under-counting whoever's week lived there.
Two optional knobs widen the scope:

```json
{ "env": {
    "GHDUTY_ORG": "your-org",
    "GHDUTY_PROJECT": "your-org/7",
    "GHDUTY_EXTRA_REPOS": "otherorg/repo,someone/fork"
} }
```

`GHDUTY_PROJECT` points at an org Project board; the report widens to **every repo
referenced by items on that board** (non-org included). Board filtering needs no
extra token scope; true per-sprint/iteration filtering needs `read:project`
(`gh auth refresh -s read:project`) — without it, the board's current items stand in
for the active sprints.

Rather than hand-editing `GHDUTY_EXTRA_REPOS`, use the **`/manage-repos`** tool to
add/remove/list extra repos (`/manage-repos add otherorg/repo`); it validates the
repo exists and persists it to a config file the summary reads (unioned with the env
var and board).

or on a schedule so your inbox gets worked unattended (Claude Code
[`/schedule`](https://code.claude.com/docs/en/schedule) or a cron that invokes
the skill).

Every run builds your queue (assigned + mentioned + review-requested, open) and
**handles the items in parallel — one subagent per item**: assigned → ticket for
`/drive`, mention → reply, review → `/code-review`. No first-run gate and no
checkbox — every run handles every item that isn't already signed or filtered
out. It's idempotent by the **signed comment in each thread**: any item ghDuty
already acted on carries a signature (ack, reply, review, or ticket-notice), so
it's skipped until someone replies after it. It acts only on repos you own or
collaborate on.

Every comment it posts ends with a signature — `🤖 auto-posted by sn0wm1ku/ghDuty
· co-authored by Claude (<model>)` — crediting the plugin and the Claude model
that wrote it, so plugin replies are easy to spot and delete (GitHub issue/PR
comments are freely editable and deletable by their author).

## Working folder

Change requests become tickets, and `/ticket` writes into `.workaholic/tickets/todo/`
**relative to the current directory**. Since ghDuty runs from an arbitrary folder
across many repos, it instead uses a **working folder** where repos live as
`<owner>/<repo>`. If the target repo isn't cloned there, ghDuty clones it on
demand, then files the ticket inside it (wired to that repo's `/drive`).

Set the working folder via `GHDUTY_WORK_DIR` (default `~/Projects`) in your
[settings.json](https://code.claude.com/docs/en/settings) `env` block:

```json
{ "env": { "GHDUTY_WORK_DIR": "/Users/you/Projects" } }
```

Repos accumulate as clones under this folder; make sure there's disk for the
repos you get mentioned in.

**Every run**, ghDuty checks the working folder is added to the current session.
If it isn't, it asks your permission before working on it and adds it with
`/add-dir` — it never clones into or writes to a folder you haven't granted the
session. It also prompts for the path if `GHDUTY_WORK_DIR` isn't set. This is the
only bootstrap — pure configuration (working folder + optional Slack webhook),
no run-state.

## Slack setup (optional)

Slack notification is **opt-in** and off by default. It uses a Slack
**Incoming Webhook** so the message posts as its own app and actually notifies
you — a message sent as yourself into your own DM would not trigger a
notification.

To get a ping when a run **creates a ticket**:

1. Create an Incoming Webhook: <https://api.slack.com/messaging/webhooks> —
   make a Slack app, enable **Incoming Webhooks**, add one to the channel (or a
   channel you'll get notified in), and copy the webhook URL
   (`https://hooks.slack.com/services/T…/B…/…`).
2. Set it via the `GHDUTY_SLACK_WEBHOOK` env var. **It's a secret** — put it in
   your **local** settings (`settings.local.json`), never a committed dotfiles
   `settings.json`:

   ```json
   { "env": { "GHDUTY_SLACK_WEBHOOK": "https://hooks.slack.com/services/T.../B.../..." } }
   ```

If `GHDUTY_SLACK_WEBHOOK` is unset, the Slack step is skipped silently — the
rest of the workflow works without any Slack config.

## How it avoids double-handling

No timestamp, no notification read-state (which would drop assigned/read-but-undone
work). Two records, by outcome:

- **Acted** (ack / reply / review / ticket) → a **signed comment** in the thread.
  Remote, durable — this is the correctness record. Before acting, a subagent
  checks whether a ghDuty comment is already there with nothing newer, and skips.
- **Considered but no action needed** (a bare FYI, an ack, a resolved thread) →
  an entry in a local **skip-ledger** (`${CLAUDE_PLUGIN_DATA}/skip-ledger.jsonl`)
  keyed by the thread's `updatedAt`, so it isn't re-read every run. It's a pure
  optimization cache — delete it and you just re-read those threads once.

New activity after either marker (a reply after our comment, or a bumped
`updatedAt` past the ledger entry) makes the item actionable again — exactly when
it should be re-handled.

## License

MIT
