// @ts-check

import { ACTIVE_LIFECYCLES, ATTENTION, LIFECYCLE, SOURCE_LABEL } from './constants.js'
import { isUrgent } from './filters.js'

/** @typedef {import('../types').Evidence} Evidence */
/** @typedef {import('../types').SessionView} SessionView */
/** @typedef {import('../types').AgentView} AgentView */
/** @typedef {import('../types').ProjectView} ProjectView */
/** @typedef {import('../types').WorktreeView} WorktreeView */
/** @typedef {import('../types').UsageView} UsageView */
/** @typedef {[label: string, value: string, isMono: boolean, isMore?: boolean]} Field */

/**
 * @param {number} ms
 * @returns {string}
 */
export function ago(ms) {
  if (!Number.isFinite(ms)) return '—'
  return ms < 45_000 ? 'now' : duration(ms)
}

/**
 * @param {number} ms
 * @returns {string}
 */
export function since(ms) {
  const a = ago(ms)
  return a === 'now' ? 'just now' : `${a} ago`
}

/**
 * @param {string | null | undefined} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  const clean = (text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/**
 * @param {string} text
 * @returns {string}
 */
export function escapeXml(text) {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * @param {string | null | undefined} model
 * @returns {string}
 */
export function shortModel(model) {
  if (!model) return 'model unknown'
  const m = model.toLowerCase()
  const family = ['opus', 'sonnet', 'haiku', 'fable'].find(name => m.includes(name))
  if (!family) return model
  const version = m.match(/(\d+)[-.](\d+)/)
  const label = family.charAt(0).toUpperCase() + family.slice(1)
  return version ? `${label} ${version[1]}.${version[2]}` : label
}

/**
 * @param {number | null | undefined} at
 * @returns {string}
 */
export function clockTime(at) {
  if (!at) return '—'
  const d = new Date(at)
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * @param {number | null} observedAt
 * @param {number} now
 * @param {number} staleMs
 * @returns {'fresh' | 'recent' | 'stale' | 'unknown'}
 */
function freshness(observedAt, now, staleMs) {
  if (!observedAt) return 'unknown'
  const age = now - observedAt
  if (age < 60_000) return 'fresh'
  if (age < staleMs) return 'recent'
  return 'stale'
}

/**
 * Stable 32-bit FNV-1a hash.
 * @param {string} text
 * @returns {number}
 */
export function hash(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * A short length of time in whole minutes or more: `<1m`, `12m`, `3h`, `2d`.
 * @param {number} ms
 * @returns {string}
 */
export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 60_000) return '<1m'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * @param {number} usd
 * @returns {string}
 */
export function money(usd) {
  if (usd < 0.01) return '<$0.01'
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`
}

/**
 * Whether a session's state is one whose length matters: it runs, waits on
 * you, or needs you.
 * @param {SessionView} s
 * @returns {boolean}
 */
function isTimed(s) {
  return ACTIVE_LIFECYCLES.includes(s.lifecycle) || isUrgent(s)
}

/**
 * The shared-checkout note, one wording everywhere.
 * @param {number} count other active sessions in the same checkout
 * @returns {string}
 */
export function peersNote(count) {
  return `same checkout as ${plural(count, 'other active session')}`
}

/**
 * "1 session", "3 sessions".
 * @param {number} count
 * @param {string} noun the singular
 * @returns {string}
 */
export function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The key, `1`–`9`, that reaches the `index`th session needing you, the same in the pane and the pop-out; null past the ninth.
 * @param {number} index
 * @returns {string | null}
 */
export function needsYouHotkey(index) {
  return index < 9 ? String(index + 1) : null
}

/**
 * The state in a few words, with how long it has lasted when that matters:
 * `Running 8m`, `Needs permission 12m`, `Blocked 3h`, `Idle`. Needs-you
 * sessions say what they need rather than their lifecycle.
 * @param {SessionView} s
 * @param {number} now
 * @returns {string}
 */
export function stateText(s, now) {
  const label = s.attention && isUrgent(s) ? ATTENTION[s.attention].label : LIFECYCLE[s.lifecycle].label
  const from = s.attention === 'pr' && s.attentionSince ? s.attentionSince : s.stateSince
  return isTimed(s) && from ? `${label} ${duration(now - from)}` : label
}

/**
 * The inferred stuck hint in words, one wording everywhere: `Maybe stuck · 4 of the last 6 calls failed`.
 * @param {SessionView} s
 * @returns {string | null}
 */
export function stuckText(s) {
  return s.stuck ? `Maybe stuck · ${s.stuck.text}` : null
}

/**
 * When a limit resets: the clock today, the month-day and clock on another day.
 * @param {number} at
 * @param {number} now
 */
function resetText(at, now) {
  const stamp = clockTime(at)
  if (stamp.slice(0, 10) === clockTime(now).slice(0, 10)) return stamp.slice(11)
  const d = new Date(at)
  return `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]} ${stamp.slice(11)}`
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const KIND_SHORT = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d Opus', seven_day_sonnet: '7d Sonnet' }
const KIND_LONG = { five_hour: '5-hour', seven_day: '7-day', seven_day_opus: '7-day Opus', seven_day_sonnet: '7-day Sonnet' }

/** A limit window's names: short for the header ("5h", "7d Opus", else a few words), long for speech ("5-hour"). @param {string} kind */
function kindNames(kind) {
  const words = kind.replace(/_/g, ' ').trim()
  const short = KIND_SHORT[/** @type {keyof typeof KIND_SHORT} */ (kind)] ?? (words.length > 10 ? `${words.slice(0, 8).trimEnd()}…` : words)
  return { short, long: KIND_LONG[/** @type {keyof typeof KIND_LONG} */ (kind)] ?? words }
}

/**
 * The rate-limit windows that have not reset yet, ready to show, or null.
 * `asOf` is set when the reading is more than 15 minutes old.
 * @param {UsageView | null | undefined} usage
 * @param {number} now
 * @returns {{ parts: { text: string, long: string, percent: number, level: 'normal' | 'high' | 'critical', isHigh: boolean, resets: string | null }[], max: number, asOf: string | null } | null}
 */
export function limitsView(usage, now) {
  if (!usage) return null
  const open = usage.rateLimits.filter(l => !l.resetsAt || !(Date.parse(l.resetsAt) <= now))
  if (open.length === 0) return null
  const parts = open.map(l => {
    const percent = Math.round(l.percentUsed)
    const level = /** @type {'normal' | 'high' | 'critical'} */ (percent >= 95 ? 'critical' : percent >= 80 ? 'high' : 'normal')
    const names = kindNames(l.kind)
    return {
      text: `${names.short} ${percent}%`,
      long: names.long,
      percent,
      level,
      isHigh: level !== 'normal',
      resets: l.resetsAt && Number.isFinite(Date.parse(l.resetsAt)) ? resetText(Date.parse(l.resetsAt), now) : null,
    }
  })
  const at = usage.evidence.observedAt
  const asOf = at && now - at > 15 * 60_000 ? clockTime(at).slice(11) : null
  return { parts, max: Math.max(...open.map(l => l.percentUsed)), asOf }
}

/**
 * The detail rows shown for a project, the same in the pane and the pop-out.
 * @param {ProjectView} p
 * @returns {Field[]}
 */
export function projectFields(p) {
  /** @type {(Field | null)[]} */
  const rows = [['Root', p.root, true], p.remote ? ['Remote', p.remote, false] : null, ['Running agents', String(p.activeAgents), false]]
  return rows.filter(/** @returns {r is Field} */ r => r !== null)
}

/**
 * Where a status came from, how sure it is and how fresh, in words.
 * @param {Evidence} ev
 * @param {number} now
 * @param {number} staleMs
 * @returns {string}
 */
function evidenceText(ev, now, staleMs) {
  const source = SOURCE_LABEL[ev.source] ?? ev.source
  const when = ev.observedAt ? `${since(now - ev.observedAt)}, ${freshness(ev.observedAt, now, staleMs)}` : 'time unknown'
  return `${ev.confidence} from ${source} (${when})${ev.detail ? ` — ${truncate(ev.detail, 80)}` : ''}`
}

/**
 * @param {SessionView} s
 * @returns {string | null} null when the session does not report it
 */
function contextText(s) {
  if (s.context.percent === null) return s.publisher ? 'not measured yet' : null
  const tokens = s.context.tokens !== null && s.context.window ? ` (${Math.round(s.context.tokens / 1000)}k of ${Math.round(s.context.window / 1000)}k tokens)` : ''
  return `${s.context.percent}%${tokens}`
}

/**
 * A session's detail rows, shared by the pane and the pop-out window. Rows
 * with nothing to say are left out; `isMore` rows sit behind "More details".
 * @param {SessionView} s
 * @param {ProjectView | undefined} project
 * @param {WorktreeView | undefined} worktree
 * @param {number} now
 * @param {number} staleMs
 * @param {readonly SessionView[]} [peers] other active sessions in the same checkout
 * @returns {Field[]}
 */
export function sessionFields(s, project, worktree, now, staleMs, peers = []) {
  const context = contextText(s)
  const action = s.activity ?? (s.lifecycle === 'running' ? 'working' : null)
  /** @type {(Field | null)[]} */
  const rows = [
    s.attentionText ? ['Needs', s.attentionEvidence ? `${s.attentionText} (from ${SOURCE_LABEL[s.attentionEvidence.source] ?? 'no source'}${s.attentionSince ? `, since ${clockTime(s.attentionSince).slice(11)}` : ''})` : s.attentionText, false] : null,
    s.summary ? ['Objective', s.summary, false] : null,
    action ? ['Current action', action, false] : null,
    ['Project', `${project?.name ?? '—'}${project?.remote ? ` (${project.remote})` : ''}`, false],
    [worktree && !worktree.isMain ? 'Worktree' : 'Folder', s.cwd ?? '—', true, true],
    peers.length > 0 ? ['Same checkout', `${peers.map(p => truncate(p.title, 40)).join(', ')} (active here too; may edit the same files)`, false] : null,
    s.branch ? ['Branch', s.branch, true] : null,
    ['Model', `${s.model ?? 'unknown'}${s.effort ? ` · effort ${s.effort}` : ''}`, false],
    context ? ['Context window', context, false, true] : null,
    typeof s.cost === 'number' ? ['Cost so far', `${money(s.cost)} (list price, reported by the session)`, false, true] : s.publisher ? ['Cost so far', 'not reported yet', false, true] : null,
    s.stateSince
      ? ['In this state', `${duration(now - s.stateSince)} (since ${clockTime(s.stateSince).slice(11)}, from ${SOURCE_LABEL[s.lifecycleEvidence.source] ?? 'no source'})`, false]
      : null,
    ['Last activity', `${clockTime(s.lastActivityAt)} (${since(now - s.lastActivityAt)})`, false],
    s.turns !== null ? ['Turns', String(s.turns), false, true] : null,
    ['Environment', s.environment, false, true],
    ['Created', clockTime(s.createdAt), false, true],
    ['Session ID', s.localId ?? s.cliSessionId ?? s.key, true, true],
    ['Status source', evidenceText(s.lifecycleEvidence, now, staleMs), false, true],
    s.attentionEvidence ? ['Needs source', evidenceText(s.attentionEvidence, now, staleMs), false, true] : null,
    ['Phase source', evidenceText(s.phaseEvidence, now, staleMs), false, true],
  ]
  return rows.filter(/** @returns {r is Field} */ r => r !== null)
}

/**
 * A subagent's detail rows, shared by the pane and the pop-out window.
 * @param {AgentView} a
 * @param {string} parentTitle
 * @param {number} now
 * @param {number} staleMs
 * @returns {Field[]}
 */
export function agentFields(a, parentTitle, now, staleMs) {
  /** @type {(Field | null)[]} */
  const rows = [
    ['Parent session', parentTitle, false],
    ['Role', a.type, false],
    a.name ? ['Name', a.name, false] : null,
    a.model ? ['Model', a.model, false] : null,
    a.description.length > 80 ? ['Objective', a.description, false] : null,
    a.activity ? ['Current activity', a.activity, false] : null,
    a.lastActivityAt ? ['Last activity', since(now - a.lastActivityAt), false] : null,
    a.finishedAt !== null ? ['Finished', clockTime(a.finishedAt), false] : null,
    ['Started', clockTime(a.startedAt), false, true],
    ['Agent ID', a.id, true, true],
    ['Status source', evidenceText(a.evidence, now, staleMs), false, true],
  ]
  return rows.filter(/** @returns {r is Field} */ r => r !== null)
}

/**
 * Whether a sub-agent belongs to the viewing session itself, by its parent's
 * Claude Code id; the snapshot's `isOwnSession` is relative to the leader.
 * @param {{ cliSessionId: string | null } | undefined} parent
 * @param {string} me the viewer's own Claude Code session id
 */
export function isViewersAgent(parent, me) {
  return Boolean(me) && parent?.cliSessionId === me
}
