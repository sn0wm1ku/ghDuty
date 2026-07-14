export const meta = {
  name: 'gh-mentions',
  description: 'ghDuty: handle the durable GitHub queue (review-requested + assigned + mentioned, all open) — discover & dedupe, apply the ledger fast-skip, one agent per item (idempotent by signature, ownership-gated, LGTM auto-approve, ticket+push via MCP), then Slack-notify tickets in the canonical format. Deterministic: the whole orchestration lives here so no step is dropped.',
  phases: [
    { title: 'Discover', detail: '3 durable gh searches, dedupe, ledger fast-skip' },
    { title: 'Handle', detail: 'one agent per item: idempotency, classify, act (signed)' },
    { title: 'Notify', detail: 'Slack ticket notification in canonical format' },
  ],
}

const QUEUE = {
  type: 'object',
  properties: { items: { type: 'array', items: {
    type: 'object',
    properties: {
      repo: { type: 'string' }, number: { type: 'integer' },
      isPR: { type: 'boolean' }, srcs: { type: 'array', items: { type: 'string' } },
      updatedAt: { type: 'string' }, title: { type: 'string' },
    },
    required: ['repo', 'number', 'isPR', 'srcs'],
  } }, skipped_by_ledger: { type: 'integer' } },
  required: ['items'],
}

const RESULT = {
  type: 'object',
  properties: {
    repo: { type: 'string' }, number: { type: 'integer' }, title: { type: 'string' },
    url: { type: 'string' },
    action: { type: 'string', enum: ['replied', 'acked', 'ticketed', 'reviewed', 'approved', 'skipped-signed', 'skipped-stale', 'skipped-not-mine', 'skipped-noaction', 'error'] },
    branch: { type: 'string' }, note: { type: 'string' },
  },
  required: ['repo', 'number', 'action', 'note'],
}

const LED = "${CLAUDE_PLUGIN_DATA:-$HOME/.claude/ghduty}/skip-ledger"

// ── Discover: search, dedupe, migrate + apply ledger fast-skip ───────────────
phase('Discover')
// Discovery, ledger migration, and the ledger fast-skip are done in CODE (bash
// gh + jq) by the skill BEFORE this workflow is invoked — no LLM is spent on that
// mechanical search/dedupe/diff. The pre-filtered survivor work-set arrives via args:
//   args = { items: [{repo, number, isPR, srcs, updatedAt, title}], fast_skipped: <int> }
// The workflow spends LLM only on the items that actually need judgement.
// args may arrive as a JSON string (some harnesses stringify it) — parse first.
const a = typeof args === 'string' ? JSON.parse(args) : (args || {})
const items = (a && a.items) || []
const fastSkipped = (a && a.fast_skipped) || 0
log(`${items.length} items to handle · ${fastSkipped} fast-skipped by ledger (done in code)`)

// ── Handle: one agent per item ───────────────────────────────────────────────
phase('Handle')
const handle = (it) => `ghDuty per-item handler for **${it.repo}#${it.number}** (isPR=${it.isPR}, via: ${(it.srcs || []).join('+')}, updatedAt=${it.updatedAt || '?'}). Act autonomously, no questions. All remote writes via the GitHub MCP (add_issue_comment / create_branch / create_or_update_file / pull_request_review_write) — never git push / gh write.

1. OWNERSHIP GATE FIRST: gh api repos/${it.repo} --jq .permissions ; if the user is not owner/collaborator (push/admin), return action="skipped-not-mine", post nothing.
2. Read the thread: gh ${it.isPR ? 'pr' : 'issue'} view ${it.number} -R ${it.repo} --comments
3. IDEMPOTENCY: if a comment with signature "auto-posted by sn0wm1ku/ghDuty" exists with NOTHING newer after it → action="skipped-signed".
4. STALENESS: if srcs is exactly ["mention"] and the mentioning comment's created_at is >2 years ago → action="skipped-stale". (assigned/review handled regardless of age.)
5. CLASSIFY & ACT (sign every posted comment with the signature block below):
   - assigned ISSUE with a linked PR → ack comment on the issue, action="acked".
   - assigned ISSUE, no PR → run workaholic /ticket in the repo clone under \${GHDUTY_WORK_DIR:-$HOME/Projects}/${it.repo}, push a ghduty/ticket-* branch via MCP, signed comment; action="ticketed", set branch.
   - assigned OPEN PR → read diff + linked issue; gap → ticket (as above, "ticketed"); already shipped → signed comment suggesting close ("acked").
   - review-requested (or a comment asking for review) → run /code-review, post findings signed. If LGTM / no blocking findings, ALSO submit a real approval via pull_request_review_write (method create, event APPROVE) → action="approved"; if blocking, request changes / comment → action="reviewed".
   - mention asking something → reply (or ticket+reply if a change request), signed → "replied".
   - nothing to do → action="skipped-noaction", post nothing.
6. RECORD in the ledger for EVERY terminal verdict — acted (ack/reply/review/approve/
   ticket) AND no-action — so next run FAST-SKIPS it (no subagent, no thread read)
   unless there's newer activity. This is the token win: don't re-read already-signed
   threads every run. **Use the thread's CURRENT updatedAt** (re-read it AFTER you
   posted, since your own comment bumps it — else next run sees a newer updatedAt and
   re-handles). If you posted nothing (no-action / skipped-signed), the queried
   updatedAt is already current. Write parallel-safe (own key only):
   LED="\${CLAUDE_PLUGIN_DATA:-$HOME/.claude/ghduty}/skip-ledger"; f="$LED/$(echo "${it.repo}#${it.number}" | tr '/#' '__').json"
   U=$(gh ${it.isPR ? 'pr' : 'issue'} view ${it.number} -R ${it.repo} --json updatedAt -q .updatedAt)
   tmp="$(mktemp)"; jq -n --arg u "$U" '{updatedAt:$u}' > "$tmp" && mv "$tmp" "$f"
   (Skip the ledger write only on action="error". The signed comment remains the
   durable correctness record; the ledger is just the efficiency cache. New activity
   after our signature bumps updatedAt → the fast-skip misses → the item is re-handled,
   which is exactly right.)
7. Return the structured result: include the issue/PR title, its **url** (html_url of the issue/PR, e.g. https://github.com/${it.repo}/${it.isPR ? 'pull' : 'issues'}/${it.number}), and branch for tickets.

Signature block to append to every posted comment:
---
<sub>🤖 auto-posted by [sn0wm1ku/ghDuty](https://github.com/sn0wm1ku/ghDuty) · co-authored by Claude (claude-opus-4-8)</sub>`

const results = (await parallel(items.map(it => () =>
  agent(handle(it), { label: `${it.repo}#${it.number}`, schema: RESULT, agentType: 'general-purpose' })
))).filter(Boolean)

// ── Notify: Slack notification — EVERY item listed, never collapsed ──────────
phase('Notify')
const tickets = results.filter(r => r.action === 'ticketed')
// Grouped sections, but every handled item is printed on its own line (no tallies-only).
const SECTIONS = [
  ['ticketed', ':ticket: Tickets created'], ['reviewed', ':mag: Reviewed'],
  ['approved', ':white_check_mark: Approved'], ['acked', ':memo: Acknowledged'],
  ['replied', ':speech_balloon: Replied'], ['skipped-signed', ':fast_forward: Already signed'],
  ['skipped-noaction', ':white_circle: No action'], ['skipped-stale', ':hourglass: Stale (>2yr mention)'],
  ['skipped-not-mine', ':no_entry: Not my repo'], ['error', ':warning: Error'],
]
// Slack mrkdwn links so every item is clickable: <url|text>
const link = (r) => `<${r.url || `https://github.com/${r.repo}/issues/${r.number}`}|${r.repo}#${r.number}>`
const branchLink = (r) => r.branch ? `<https://github.com/${r.repo}/tree/${r.branch}|${r.branch}>` : '?'
const fmt = (r) => r.action === 'ticketed'
  ? `• ${link(r)} — ${r.title || '(ticket)'}\n  branch ${branchLink(r)} · run \`/drive\``
  : `• ${link(r)}${r.title ? ' — ' + r.title : ''}${r.note ? ' — ' + r.note : ''}`
let msg = `:robot_face: *ghDuty run* — ${results.length} items handled` +
  (fastSkipped ? ` (+${fastSkipped} ledger fast-skipped)` : '')
for (const [act, label] of SECTIONS) {
  const rs = results.filter(r => r.action === act)
  if (rs.length) msg += `\n\n*${label} (${rs.length}):*\n` + rs.map(fmt).join('\n')
}

// Slack delivery: in auto mode the agent cannot send an external write by any
// route (curl, settings-grant, outbox-for-hook) — that's by design. So this only
// ATTEMPTS the send honestly; if the classifier blocks it, it returns the exact
// ready-to-run curl for the user to run themselves (or to run outside auto mode).
let notified = false
if (results.length) {
  const n = await agent(
    `If GHDUTY_SLACK_WEBHOOK is set, attempt to POST this notification to Slack (message text VERBATIM — every item listed, don't collapse):

  MSG_TEXT=$(cat <<'MSGEOF'
${msg}
MSGEOF
)
  curl -sS -X POST -H 'Content-type: application/json' --data "$(jq -n --arg t "$MSG_TEXT" '{text:$t}')" "$GHDUTY_SLACK_WEBHOOK"

Do NOT try to talk around or bypass any permission denial. Return {sent:true} on HTTP 200. If it's denied, return {sent:false, reason:"blocked — run this yourself: <the exact curl command with the payload>"}. If no webhook, {sent:false, reason:"no webhook"}.`,
    { label: 'slack-send', schema: { type: 'object', properties: { sent: { type: 'boolean' }, reason: { type: 'string' } }, required: ['sent'] }, agentType: 'general-purpose' }
  )
  notified = !!(n && n.sent)
  if (!notified) log(`Slack notify not sent: ${(n && n.reason) || 'unknown'}`)
}

const by = {}
for (const r of results) by[r.action] = (by[r.action] || 0) + 1
return { total: items.length, fast_skipped: fastSkipped, by, notified, tickets: tickets.map(t => ({ repo: t.repo, number: t.number, branch: t.branch })) }
