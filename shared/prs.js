// @ts-check

export { isPrUrl } from './pr-links.js'

/** @typedef {import('../types').PrStatus} PrStatus */

const PR_FIELDS = 'number,title,state,isDraft,reviewDecision,statusCheckRollup,mergeStateStatus'
const PR_FAILING_NAMES = 5
const PR_TITLE_MAX = 200

/**
 * A PR title as plain one-line text: control and direction-override
 * characters dropped, spaces collapsed, at most 200 characters; null when empty.
 * @param {unknown} title
 * @returns {string | null}
 */
function cleanTitle(title) {
  if (typeof title !== 'string') return null
  const text = title
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, PR_TITLE_MAX) : null
}

const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error'])
const PENDING = new Set(['queued', 'in_progress', 'pending', 'expected', 'waiting', 'requested'])
const PASSING = new Set(['success', 'neutral', 'skipped'])

/**
 * The `gh pr view` argv for one PR (no shell; the URL is checked first).
 * @param {string} url
 * @returns {string[]}
 */
export function prViewArgs(url) {
  return ['pr', 'view', url, '--json', PR_FIELDS]
}

/**
 * @param {any} item a `statusCheckRollup` entry: a CheckRun (`status`, `conclusion`) or a StatusContext (`state`)
 * @returns {'failing' | 'pending' | 'passing' | null}
 */
function checkState(item) {
  if (!item || typeof item !== 'object') return null
  const lower = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.toLowerCase() : '')
  const isCheckRun = item.__typename === 'CheckRun' || (item.state === undefined && (item.status !== undefined || item.conclusion !== undefined))
  const word = isCheckRun ? (lower(item.status) === 'completed' ? lower(item.conclusion) : lower(item.status) || 'pending') : lower(item.state)
  if (FAILING.has(word)) return 'failing'
  if (PENDING.has(word)) return 'pending'
  if (PASSING.has(word)) return 'passing'
  return null
}

/**
 * The rollup with re-runs folded: one entry per check (CheckRun workflow and
 * name, or StatusContext context), the latest by completion or start time,
 * so a passed re-run hides the failure before it.
 * @param {any[]} rollup
 * @returns {any[]}
 */
export function latestChecks(rollup) {
  /** @type {Map<string, { item: any, at: string, index: number }>} */
  const latest = new Map()
  rollup.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const name = item.__typename === 'StatusContext' || item.context !== undefined ? `ctx|${item.context ?? ''}` : `run|${item.workflowName ?? ''}|${item.name ?? ''}`
    const at = String(item.completedAt || item.startedAt || '')
    const current = latest.get(name)
    if (!current || at > current.at || (at === current.at && index > current.index)) latest.set(name, { item, at, index })
  })
  return [...latest.values()].sort((a, b) => a.index - b.index).map(v => v.item)
}

/**
 * `gh pr view --json number,title,state,isDraft,reviewDecision,statusCheckRollup,...`
 * output reduced to what Orbit shows: state, the title, one checks verdict (any failing
 * wins, then pending, then passing), up to five failing check names, and the
 * review decision.
 * @param {any} raw
 * @param {number} now
 * @returns {PrStatus | null}
 */
export function prSummary(raw, now) {
  if (!raw || typeof raw !== 'object') return null
  const upper = typeof raw.state === 'string' ? raw.state.toUpperCase() : ''
  /** @type {PrStatus['state']} */
  const state = upper === 'MERGED' ? 'merged' : upper === 'CLOSED' ? 'closed' : raw.isDraft === true ? 'draft' : 'open'
  const rollup = latestChecks(Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : [])
  /** @type {string[]} */
  const failing = []
  let isPending = false
  let isPassing = false
  for (const item of rollup) {
    const verdict = checkState(item)
    if (verdict === 'failing') {
      const name = String(item.name || item.context || 'check').replace(/[\u0000-\u001f]/g, '').slice(0, 60)
      if (!failing.includes(name)) failing.push(name)
    } else if (verdict === 'pending') isPending = true
    else if (verdict === 'passing') isPassing = true
  }
  const decision = typeof raw.reviewDecision === 'string' ? raw.reviewDecision.toUpperCase() : ''
  return {
    state,
    title: cleanTitle(raw.title),
    checks: failing.length ? 'failing' : isPending ? 'pending' : isPassing ? 'passing' : 'none',
    failing: failing.slice(0, PR_FAILING_NAMES),
    review: decision === 'APPROVED' ? 'approved' : decision === 'CHANGES_REQUESTED' ? 'changes' : decision === 'REVIEW_REQUIRED' ? 'required' : null,
    checkedAt: now,
  }
}

/**
 * When to ask `gh` again: open PRs every 2 minutes, merged or closed ones
 * hourly, a PR `gh` could not read every 10 minutes.
 * @param {{ status: PrStatus | null, checkedAt: number, failed: boolean } | undefined} entry
 * @param {number} now
 * @returns {boolean}
 */
export function isPrDue(entry, now) {
  if (!entry) return true
  const age = now - entry.checkedAt
  if (entry.failed || !entry.status) return age >= 10 * 60_000
  if (entry.status.state === 'merged' || entry.status.state === 'closed') return age >= 60 * 60_000
  return age >= 2 * 60_000
}

/**
 * Why `gh` cannot be used at all right now (back off and say so), or null
 * when only this one PR failed. Reads stderr and the error code, never prints them.
 * @param {string} stderr
 * @param {string | number | null | undefined} code
 * @returns {'not installed' | 'not signed in' | 'rate limited' | null}
 */
export function ghUnavailable(stderr, code) {
  if (code === 'ENOENT') return 'not installed'
  if (/gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(stderr)) return 'not signed in'
  if (/rate limit|HTTP 403: API rate|secondary rate/i.test(stderr)) return 'rate limited'
  return null
}

/**
 * The server's PR-checks state in words for Diagnostics and the status bar.
 * @param {{ state: 'idle' | 'ok' | 'unavailable', reason: string | null } | null | undefined} checks
 * @returns {string}
 */
export function prChecksText(checks) {
  if (!checks || checks.state === 'idle') return 'PR checks: idle'
  return checks.state === 'unavailable' ? `PR checks: unavailable (${checks.reason ?? 'unknown'})` : 'PR checks: ok'
}
