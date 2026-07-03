export const meta = {
  name: 'org-work-summary',
  description: 'Deep-read every PR in the org-work-summary work-set IN PARALLEL via schedule-planner agents (concurrency auto-capped ~min(16,cores-2)), returning per-PR verdicts for the weekly report. The mechanical gather (org+extra searches, dedupe, commit tally, backlog) is done in CODE by the caller and passed in via args.prs; this workflow is only the parallel LLM deep-read — far faster than launching one Agent at a time.',
  phases: [{ title: 'Analyze', detail: 'one schedule-planner per PR, parallel' }],
}

const VERDICT = {
  type: 'object',
  properties: {
    repo: { type: 'string' }, number: { type: 'integer' }, url: { type: 'string' },
    author: { type: 'string' }, state: { type: 'string' }, objective: { type: 'string' },
    verdict: { type: 'string' }, criteria_done: { type: 'string' },
    remaining: { type: 'array', items: { type: 'string' } },
    work_item_age_days: { type: 'integer' }, stalled: { type: 'boolean' },
    eta: { type: 'object' }, satisfies_objective: { type: 'boolean' }, release_ready: { type: 'boolean' },
    strengths: { type: 'array', items: { type: 'string' } },
    followup_debt: { type: 'array', items: { type: 'string' } },
    one_line: { type: 'string' }, implication: { type: 'string' }, suggested_action: { type: 'string' },
  },
  required: ['repo', 'number', 'one_line'],
}

const _a = (typeof args === 'string') ? JSON.parse(args) : args
const prs = (_a && _a.prs) || []
log(`deep-reading ${prs.length} PRs via schedule-planner (parallel, org + extra)`)

phase('Analyze')
const verdicts = (await parallel(prs.map(p => () =>
  agent(
    `Analyze ${p.state || 'open'} PR #${p.number} in ${p.repo} (author ${p.author || '?'}, ${p.isPR === false ? 'issue' : 'PR'}, title ${JSON.stringify(p.title || '')}). This may be a non-org "extra" repo — treat it exactly like an org one. Follow your schedule-planner method: establish the objective (\`gh ${p.isPR === false ? 'issue' : 'pr'} view ${p.number} -R ${p.repo} --json number,title,state,body,closingIssuesReferences,additions,deletions,changedFiles,createdAt,updatedAt\` + read the linked issue), read the diff (\`gh pr diff ${p.number} -R ${p.repo}\`), and produce a ${p.state === 'merged' ? 'QUALITY (satisfies objective? truly done/release-ready? follow-up debt?) — delegate code-quality depth to /code-review' : 'PROGRESS (criteria done vs remaining, Work Item Age, honest ETA, stalled?)'} verdict. Return ONLY the structured JSON verdict; include url ${p.url || ''}.`,
    { label: `${p.repo}#${p.number}`, schema: VERDICT, agentType: 'ghduty:schedule-planner' }
  )
))).filter(Boolean)

return { verdicts, total: prs.length }
