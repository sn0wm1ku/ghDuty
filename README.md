# ghDuty

**GitHub duty** — a Claude Code plugin that runs as an automated agent whose core
job is to **automate your pending tasks**. It builds a queue from durable GitHub
state across all repos and, in parallel:

- **Assigned to you** → runs `/ticket` (from [workaholic](https://github.com/qmu/workaholic)) in the target repo's clone, queuing it for `/drive`. Self-assigned counts too — it still needs doing.
- **Mentions you** → replies to every one (answers a question, or tickets + replies for a change request), unless the mentioning *comment* is older than 2 years — a stale @ isn't worth answering (judged by the comment's date, not the issue's).
- **Review requested** → runs `/code-review` (from [code-review](https://github.com/anthropics/claude-plugins-official)) against the PR.
- **Tickets created this run** → optionally pings you on Slack.

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

or on a schedule so your inbox gets worked unattended (Claude Code
[`/schedule`](https://code.claude.com/docs/en/schedule) or a cron that invokes
the skill).

Each run builds your queue (assigned + mentioned + review-requested, open) and
**handles the items in parallel — one subagent per item**: assigned → ticket for
`/drive`, mention → reply, review → `/code-review`. On an interactive run the
queue can be offered as an `AskUserQuestion` checkbox list to pick which to
handle; a scheduled run handles them all. It's idempotent — a mention/review with
a ghDuty reply already there is skipped, and an assigned task whose ticket already
exists in the clone isn't re-filed — and it acts only on repos you own or
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
session. On the very first run it also prompts for the path if `GHDUTY_WORK_DIR`
isn't set.

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

There is no timestamp and it doesn't rely on notification read-state (which would
drop assigned/read-but-undone work). Every comment ghDuty posts carries its
signature, and **the signature is the idempotency**: before acting on a thread a
subagent checks whether a ghDuty reply is already there with no newer comment
after it, and skips if so. A thread becomes actionable again only when someone
replies after ghDuty's last comment — exactly when it should be re-handled.

## License

MIT
