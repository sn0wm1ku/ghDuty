# ghDuty

**GitHub mention duty** — a Claude Code plugin that runs as an automated agent:
it checks every issue and PR that `@`-mentions you across all your repos and
**handles each action request on its own**, no per-item confirmation:

- **A question** → replies with the answer.
- **A change request** → runs `/ticket` (from [workaholic](https://github.com/qmu/workaholic)) so it lands in your `.workaholic/tickets/todo/` queue.
- **A review request** → runs `/code-review` (from [code-review](https://github.com/anthropics/claude-plugins-official)) against the PR.
- **Pending tickets left over** → optionally pings you on Slack.

It handles only mentions with **new activity since the last run**, so nothing is
touched twice. The **first run just sets a baseline** — it does not drain your
historical backlog; the agent watches from install onward. The last-run
timestamp is kept in the plugin's data dir. Designed to run on a schedule.

## Requirements

- [Claude Code](https://claude.com/claude-code) **v2.1.110+** (needed for plugin dependencies)
- [`gh` CLI](https://cli.github.com/) installed and authenticated (`gh auth login`)
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

or on a schedule so mentions get handled unattended (Claude Code
[`/schedule`](https://code.claude.com/docs/en/schedule) or a cron that invokes
the skill).

Each run checks mentions with new activity since the last run and **handles each
action request automatically** — replying, ticketing, or reviewing per what the
mention asks. The **first run only sets a baseline** and handles nothing, so it
never floods on your historical backlog. It acts only on repos you own or
collaborate on.

## Slack setup (optional)

Slack notification is **opt-in** and off by default. It uses a Slack
**Incoming Webhook** so the message posts as its own app and actually notifies
you — a message sent as yourself into your own DM would not trigger a
notification.

To get a ping when a run leaves pending tickets in `.workaholic/tickets/todo/`:

1. Create an Incoming Webhook: <https://api.slack.com/messaging/webhooks> —
   make a Slack app, enable **Incoming Webhooks**, add one to the channel (or a
   channel you'll get notified in), and copy the webhook URL
   (`https://hooks.slack.com/services/T…/B…/…`).
2. Set it via the `GHDUTY_SLACK_WEBHOOK` env var in your
   [settings.json](https://code.claude.com/docs/en/settings) `env` block:

   ```json
   { "env": { "GHDUTY_SLACK_WEBHOOK": "https://hooks.slack.com/services/T.../B.../..." } }
   ```

> **The webhook URL is a secret** — anyone with it can post to your Slack. Keep
> it in local settings; do not commit it to a dotfiles repo.

If `GHDUTY_SLACK_WEBHOOK` is unset, the Slack step is skipped silently — the
rest of the workflow works without any Slack config.

## How last-run tracking works

The skill stores an ISO-8601 timestamp at `${CLAUDE_PLUGIN_DATA}/last-run`
(falling back to `~/.claude/ghduty/last-run`). Each run filters mentions with
`gh search issues --updated ">$LAST"` and stamps a fresh timestamp only after
the queue is worked. Note this filters by *last activity*, not *replied-yet*: a
thread you deliberately skip won't reappear unless it gets new activity.

## License

MIT
