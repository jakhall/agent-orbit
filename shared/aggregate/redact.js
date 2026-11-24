// @ts-check

import { cleanInboxStats } from '../inbox.js'
import { categorizeCommand, categorizeTool, commandHead } from '../redact.js'

export { categorizeCommand, categorizeTool }

/** @typedef {import('../../types').PublishedSession} PublishedSession */
/** @typedef {import('../../types').TimelineEntry} TimelineEntry */
/** @typedef {import('../../types').ToolCategory} ToolCategory */

/** @type {Record<ToolCategory, string>} */
const VERB = {
  read: 'Reading',
  search: 'Searching',
  edit: 'Editing',
  test: 'Running tests',
  'git-write': 'Committing',
  merge: 'Merging',
  shell: 'Running',
  web: 'Browsing',
  agent: 'Delegating',
  question: 'Waiting:',
  plan: 'Planning:',
  review: 'Reviewing',
  skill: 'Using skill',
  mcp: 'Calling',
  other: 'Using',
}

/**
 * @param {ToolCategory} category
 * @param {string} target
 * @returns {string}
 */
export function describeTool(category, target) {
  return `${VERB[category]} ${target}`.trim()
}

/** @type {ReadonlySet<ToolCategory>} */
const COMMAND_CATEGORIES = new Set(/** @type {ToolCategory[]} */ (['shell', 'test', 'merge', 'git-write']))
/**
 * @param {ToolCategory} category
 * @param {unknown} target
 * @returns {string}
 */
function cleanTarget(category, target) {
  const text = typeof target === 'string' ? target : ''
  if (COMMAND_CATEGORIES.has(category)) return commandHead(text)
  if (category === 'search') return text.slice(0, 40)
  return text.slice(0, 60)
}

/**
 * @param {TimelineEntry} entry
 * @returns {string}
 */
function cleanNote(entry) {
  const text = typeof entry.text === 'string' ? entry.text : ''
  return text.slice(0, 160)
}

const ERROR_PLACES = new Set(['tick', 'publish', 'inbox', 'notice', 'hook', 'render', 'daemon'])

/**
 * A record's error trace (E-29), its four fields only: an unknown place
 * drops it, a kind that is not a plain identifier reads as `Error`.
 * @param {unknown} raw
 * @returns {PublishedSession['errors']}
 */
function cleanErrors(raw) {
  const e = /** @type {{ count?: unknown, lastAt?: unknown, where?: unknown, kind?: unknown } | null} */ (raw && typeof raw === 'object' ? raw : null)
  if (!e || typeof e.where !== 'string' || !ERROR_PLACES.has(e.where)) return undefined
  if (typeof e.count !== 'number' || !Number.isFinite(e.count) || e.count < 1 || typeof e.lastAt !== 'number' || !Number.isFinite(e.lastAt)) return undefined
  const kind = typeof e.kind === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(e.kind) ? e.kind : 'Error'
  return { count: Math.floor(e.count), lastAt: e.lastAt, where: /** @type {import('../../types').ErrorWhere} */ (e.where), kind }
}

/**
 * Re-applies this version's redaction to a session record read from disk:
 * command targets reduced to their program, credentials out of the remote,
 * every free text capped.
 * @param {PublishedSession} record
 * @returns {PublishedSession}
 */
export function cleanRecord(record) {
  const tools = Array.isArray(record.tools) ? record.tools : []
  const timeline = Array.isArray(record.timeline) ? record.timeline : []
  const agents = Array.isArray(record.agents) ? record.agents : []
  return {
    ...record,
    tools: tools.map(t => {
      /** @type {ToolCategory} */
      const category = t.category in VERB ? t.category : 'other'
      return { ...t, category, target: cleanTarget(category, t.target) }
    }),
    timeline: timeline.map(e => ({ ...e, text: cleanNote(e) })),
    agents: agents.map(a => ({
      ...a,
      description: typeof a.description === 'string' ? a.description.slice(0, 120) : '',
      type: typeof a.type === 'string' ? a.type.slice(0, 60) : '',
      name: typeof a.name === 'string' ? a.name.slice(0, 60) : null,
    })),
    turn: turnOf(record.turn),
    repoRemote: typeof record.repoRemote === 'string' ? withoutCredentials(record.repoRemote) : null,
    errors: cleanErrors(record.errors),
    waiting: record.waiting ? { ...record.waiting, tool: typeof record.waiting.tool === 'string' ? record.waiting.tool.slice(0, 60) : null } : null,
    inbox: cleanInboxStats(record.inbox),
  }
}

/**
 * @param {unknown} raw
 * @returns {PublishedSession['turn']}
 */
function turnOf(raw) {
  const t = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' ? raw : {})
  const at = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return { isRunning: t.isRunning === true, startedAt: at(t.startedAt), endedAt: at(t.endedAt), lastReason: typeof t.lastReason === 'string' ? t.lastReason.slice(0, 40) : null }
}

/**
 * A remote URL with any user name, password or token taken out.
 * @param {string} remote
 * @returns {string}
 */
export function withoutCredentials(remote) {
  try {
    const url = new URL(remote)
    if (!url.username && !url.password) return remote
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return remote.replace(/\/\/[^@/]+@/, '//')
  }
}
