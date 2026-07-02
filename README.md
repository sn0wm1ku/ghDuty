# ghDuty

**GitHub mention duty** — a Claude Code plugin that goes through every issue and
PR that `@`-mentions you, across all your repos, and handles them one at a time:

- **A question** → drafts a direct reply.
- **A change request** → runs `/ticket` (from [workaholic](https://github.com/qmu/workaholic)) so it lands in your `.workaholic/tickets/todo/` queue.
- **A review request** → runs `/code-review` (from [code-review](https://github.com/anthropics/claude-plugins-official)) against the PR.
- **Pending tickets left over** → optionally pings you on Slack.

Only mentions updated **since the last run** are surfaced, so handled threads
don't come back. The last-run timestamp is kept in the plugin's data dir.

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

In any repo, ask Claude:

```
go through my GitHub mentions
```

or invoke the skill directly:

```
/gh-mentions
```

It lists your open mentions, then walks them one by one. It **confirms with you
before posting any comment or creating any ticket** — it never bulk-posts across
your repos.

## Slack setup (optional)

Slack notification is **opt-in** and off by default. To get a DM/channel ping
when a run leaves pending tickets in `.workaholic/tickets/todo/`:

1. Have the Slack MCP plugin connected in Claude Code (so
   `mcp__plugin_slack_slack__slack_send_message` is available).
2. Set the target channel via the `GHDUTY_SLACK_CHANNEL` env var — e.g. a
   channel ID like `C0123456789` or your own DM channel. Add it to your
   [settings.json](https://code.claude.com/docs/en/settings) `env` block:

   ```json
   { "env": { "GHDUTY_SLACK_CHANNEL": "C0123456789" } }
   ```

If `GHDUTY_SLACK_CHANNEL` is unset, the Slack step is skipped silently — the
rest of the workflow works without any Slack config.

## How last-run tracking works

The skill stores an ISO-8601 timestamp at `${CLAUDE_PLUGIN_DATA}/last-run`
(falling back to `~/.claude/ghduty/last-run`). Each run filters mentions with
`gh search issues --updated ">$LAST"` and stamps a fresh timestamp only after
the queue is worked. Note this filters by *last activity*, not *replied-yet*: a
thread you deliberately skip won't reappear unless it gets new activity.

## License

MIT
