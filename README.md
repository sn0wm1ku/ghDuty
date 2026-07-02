# ghDuty

**GitHub notification duty** — a Claude Code plugin that runs as an automated
agent: it works your **GitHub notification inbox** (the comment/event-level
things actually directed at you — mentions, review requests, assignments,
replies on threads you're in) across all your repos and **handles each on its
own**, no per-item confirmation:

- **A question** → replies with the answer.
- **A change request** → runs `/ticket` (from [workaholic](https://github.com/qmu/workaholic)) in the target repo's clone, so it lands in that repo's `.workaholic/tickets/todo/` queue and is wired to `/drive`.
- **A review request** → runs `/code-review` (from [code-review](https://github.com/anthropics/claude-plugins-official)) against the PR.
- **Tickets created this run** → optionally pings you on Slack.

It reads **unread** notifications, handles each, and **marks it read** when done
— read-state is the idempotency, so nothing is handled twice and a thread only
comes back when it gets new activity. No timestamps, no issue-level `mentions:`
search (which misses review-requests, assignments, and threads you commented on).
Designed to run on a schedule.

## Requirements

- [Claude Code](https://claude.com/claude-code) **v2.1.110+** (needed for plugin dependencies)
- [`gh` CLI](https://cli.github.com/) installed and authenticated (`gh auth login`). The token needs notification access — the `repo` scope covers it (verify with `gh api /notifications`).
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

Each run reads your unread notifications and **handles them in parallel — one
subagent per notification** — replying, ticketing, or reviewing per what each is,
then marking it read. On an interactive run with several items you can be offered
an `AskUserQuestion` checkbox list to pick which to handle (unticked ones stay
unread and resurface next time); a scheduled run handles them all. It acts only
on repos you own or collaborate on.

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

There is no timestamp. Discovery is your GitHub notification inbox, and
**read-state is the idempotency**: ghDuty only processes **unread** notifications
and marks each **read** after it has handled or triaged it — never before, so it
can't mark something done without processing it. A handled thread stays read
until it gets new activity, which flips it back to unread — exactly when it
should be handled again. Items you leave unticked on an interactive run stay
unread.

## License

MIT
