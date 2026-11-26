// @ts-check

import { isPrUrl } from '../prs.js'
import { errorText, joinWith } from './path-utils.js'

/** @typedef {import('../../types').PullRequestView} PullRequestView */
/** @typedef {import('./path-utils.js').Host} Host */

/**
 * @typedef {object} DesktopSession
 * @property {string} localId
 * @property {string[]} cliSessionIds
 * @property {string} title
 * @property {string | null} cwd
 * @property {number | null} createdAt
 * @property {number} lastActivityAt
 * @property {number} lastTurnEdgeAt
 * @property {boolean} isMidTurn
 * @property {'user-frame' | 'transcript' | null} midTurnSource How `isMidTurn` was decided: a typed prompt after the last turn edge, or transcript writes since it.
 * @property {number | null} turnStartedAt
 * @property {string | null} model
 * @property {string | null} effort
 * @property {string | null} permissionMode
 * @property {number | null} completedTurns
 * @property {string | null} gitRoot
 * @property {string | null} commonDir
 * @property {PullRequestView[]} prs
 * @property {string[]} writtenBranches
 * @property {{ category: string | null, detail: string, needsAction: string }} summary
 * @property {boolean} isInterruptedAwaitingPerson
 * @property {boolean} isWaitingInput
 * @property {number | null} [waitingMarkedAt] when the desktop wrote its `waiting-input` marker, when known
 * @property {number | null} [lastFocusedAt] when the person last looked at the session in the desktop app
 * @property {SessionParent | null} [parent] the session it was started from (lineage)
 * @property {SessionReport | null} [lastReport] the last turn's report and what it asks of the person
 * @property {SessionFailure | null} [failure] the newest failure mark, by category only
 * @property {boolean | null} [remoteControl] whether Remote Control is on; null when the record does not say
 * @property {boolean} [hasSuggestion] the desktop holds a suggested next prompt for the idle session (its text is read only on request)
 */

/** @typedef {{ key: string, kind: 'side-session' | 'fork' | 'hand-off' | 'spawn' }} SessionParent */
/** @typedef {{ text: string, needsUser: boolean, ask: string | null, at: number | null }} SessionReport */
/** @typedef {{ category: string, at: number, source: 'error' | 'crash' | 'mark', isCurrent: boolean }} SessionFailure */

/** @typedef {{ prNumber?: unknown, repo?: unknown, url?: unknown, branch?: unknown, state?: unknown, dismissed?: unknown }} RawPr */

/**
 * @typedef {object} RawSession
 * @property {unknown} [sessionId]
 * @property {unknown} [cliSessionId]
 * @property {unknown} [lastAssistantCliSessionId]
 * @property {unknown} [title]
 * @property {unknown} [cwd]
 * @property {unknown} [createdAt]
 * @property {unknown} [lastActivityAt]
 * @property {unknown} [lastTurnEdgeAt]
 * @property {unknown} [latestUserFrameAt]
 * @property {unknown} [model]
 * @property {unknown} [effort]
 * @property {unknown} [permissionMode]
 * @property {unknown} [completedTurns]
 * @property {unknown} [isArchived]
 * @property {unknown} [gitAnchors]
 * @property {unknown} [prs]
 * @property {unknown} [writtenBranches]
 * @property {unknown} [postTurnSummary]
 * @property {unknown} [interruptedAwaitingPerson]
 * @property {unknown} [lastFocusedAt]
 * @property {unknown} [spawnedFrom]
 * @property {unknown} [forkedFromSessionId]
 * @property {unknown} [lastTurnReport]
 * @property {unknown} [turnWrapUp]
 * @property {unknown} [error]
 * @property {unknown} [errorCategory]
 * @property {unknown} [errorAt]
 * @property {unknown} [queryCrashes]
 * @property {unknown} [priorErrorMark]
 * @property {unknown} [remoteControlUserEnabled]
 * @property {unknown} [remoteControlAutoEligible]
 * @property {unknown} [promptSuggestion]
 * @property {unknown} [hasPromptSuggestion]
 */

/**
 * @typedef {object} DesktopScan
 * @property {DesktopSession[]} sessions
 * @property {number} files
 * @property {number} parsed
 * @property {number} failed
 * @property {number} skipped records past the `maxSessions` cap, not read (E-18)
 * @property {string | null} error
 */

/**
 * @param {unknown} v
 * @returns {string | null}
 */
const str = v => (typeof v === 'string' && v !== '' ? v : null)
/**
 * @param {unknown} v
 * @returns {number | null}
 */
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * @param {unknown} value
 * @returns {PullRequestView[]}
 */
function parsePrs(value) {
  if (!Array.isArray(value)) return []
  /** @type {PullRequestView[]} */
  const out = []
  for (const raw of /** @type {RawPr[]} */ (value)) {
    const url = str(raw?.url)
    const number = num(raw?.prNumber)
    if (!url || number === null || !isPrUrl(url)) continue
    out.push({ url, number, repo: str(raw.repo) ?? '', branch: str(raw.branch), state: str(raw.state) ?? 'UNKNOWN', ...(raw.dismissed === true ? { dismissed: true } : {}) })
  }
  return out
}

const LOCAL_KEY = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const REPORT_MAX = 400
export const SUGGESTION_MAX = 1000
const ASK_MAX = 200
const INVISIBLE_RANGES = /** @type {[number, number][]} */ ([[0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0x2800, 0x2800], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0]])
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join('')}]`, 'gu')

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string | null}
 */
function plainLine(value, max) {
  if (typeof value !== 'string') return null
  const text = value.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * The desktop's suggested next prompt for an idle session, cleaned of
 * invisible characters; null while a turn runs, when absent, or when longer
 * than `SUGGESTION_MAX` (never cut, since a cut prompt is not the suggestion).
 * @param {RawSession | null | undefined} raw
 * @returns {string | null}
 */
export function promptSuggestionOf(raw) {
  if (!raw || typeof raw.promptSuggestion !== 'string') return null
  if ((num(raw.latestUserFrameAt) ?? 0) > (num(raw.lastTurnEdgeAt) ?? 0)) return null
  const text = raw.promptSuggestion.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
  return text && text.length <= SUGGESTION_MAX ? text : null
}

/**
 * @param {RawSession} raw
 * @param {string} localId
 * @returns {SessionParent | null}
 */
function parentOf(raw, localId) {
  const spawned = /** @type {{ sessionId?: unknown, handOff?: unknown, userFork?: unknown, sideSession?: unknown } | null} */ (
    raw.spawnedFrom && typeof raw.spawnedFrom === 'object' ? raw.spawnedFrom : null
  )
  const isKey = (/** @type {unknown} */ v) => typeof v === 'string' && LOCAL_KEY.test(v) && v !== localId
  if (spawned && isKey(spawned.sessionId)) {
    const kind = spawned.handOff ? 'hand-off' : spawned.userFork ? 'fork' : spawned.sideSession ? 'side-session' : 'spawn'
    return { key: /** @type {string} */ (spawned.sessionId), kind }
  }
  return isKey(raw.forkedFromSessionId) ? { key: /** @type {string} */ (raw.forkedFromSessionId), kind: 'fork' } : null
}

/**
 * @param {RawSession} raw
 * @param {number} lastTurnEdgeAt
 * @returns {SessionReport | null}
 */
function reportOf(raw, lastTurnEdgeAt) {
  const wrapUp = /** @type {{ description?: unknown, needsUser?: unknown } | null} */ (raw.turnWrapUp && typeof raw.turnWrapUp === 'object' ? raw.turnWrapUp : null)
  const text = plainLine(raw.lastTurnReport, REPORT_MAX) ?? plainLine(wrapUp?.description, REPORT_MAX)
  const ask = plainLine(wrapUp?.needsUser, ASK_MAX)
  if (!text && !ask) return null
  return { text: text ?? '', needsUser: ask !== null, ask, at: lastTurnEdgeAt || null }
}

/**
 * @param {RawSession} raw
 * @param {number} lastTurnEdgeAt
 * @returns {SessionFailure | null}
 */
function failureOf(raw, lastTurnEdgeAt) {
  /** @type {{ category: string, at: number, source: 'error' | 'crash' | 'mark' }[]} */
  const marks = []
  const category = (/** @type {unknown} */ v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : null)
  const errorAt = num(raw.errorAt)
  const errorCategory = category(raw.errorCategory)
  if (errorAt !== null && errorCategory) marks.push({ category: errorCategory, at: errorAt, source: 'error' })
  const crashes = Array.isArray(raw.queryCrashes) ? raw.queryCrashes : []
  const crash = /** @type {{ at?: unknown, errorCategory?: unknown } | undefined} */ (crashes.at(-1))
  const crashAt = num(crash?.at)
  const crashCategory = category(crash?.errorCategory)
  if (crashAt !== null && crashCategory) marks.push({ category: crashCategory, at: crashAt, source: 'crash' })
  const mark = /** @type {{ at?: unknown, category?: unknown } | null} */ (raw.priorErrorMark && typeof raw.priorErrorMark === 'object' ? raw.priorErrorMark : null)
  const markAt = num(mark?.at)
  const markCategory = category(mark?.category)
  if (markAt !== null && markCategory) marks.push({ category: markCategory, at: markAt, source: 'mark' })
  const newest = marks.sort((a, b) => b.at - a.at)[0]
  return newest ? { ...newest, isCurrent: newest.at > lastTurnEdgeAt } : null
}

/**
 * @param {RawSession} raw
 * @param {number} fileMtime
 * @param {ReadonlySet<string> | ReadonlyMap<string, number | null>} waiting `waiting-input` markers by local id, with each marker's write time when known
 * @returns {DesktopSession | null}
 */
export function normalizeDesktop(raw, fileMtime, waiting) {
  const localId = str(raw.sessionId)
  if (!localId || raw.isArchived === true) return null
  const anchors = Array.isArray(raw.gitAnchors) ? /** @type {{ gitRoot?: unknown, commonDir?: unknown }[]} */ (raw.gitAnchors) : []
  const anchor = anchors[0]
  const summary = /** @type {{ status_category?: unknown, status_detail?: unknown, needs_action?: unknown }} */ (
    raw.postTurnSummary && typeof raw.postTurnSummary === 'object' ? raw.postTurnSummary : {}
  )
  const lastTurnEdgeAt = num(raw.lastTurnEdgeAt) ?? 0
  const branches = Array.isArray(raw.writtenBranches)
    ? /** @type {unknown[]} */ (raw.writtenBranches).flatMap(b => {
        const text = str(b)
        if (!text) return []
        const name = text.split('\u0000').at(-1)
        return name ? [name] : []
      })
    : []
  const cliIds = [str(raw.cliSessionId), str(raw.lastAssistantCliSessionId)].filter(v => v !== null)
  const typedAt = num(raw.latestUserFrameAt)
  const isWaitingInput = isWaitingOnPerson(raw, localId, waiting)
  const markedAt = waiting instanceof Map ? waiting.get(localId) : undefined
  const startingAt = waiting.has(localId) && !isWaitingInput ? markedAt ?? num(raw.lastActivityAt) ?? fileMtime : null
  const isMidTurn = (typedAt ?? 0) > lastTurnEdgeAt || startingAt !== null
  return {
    localId,
    cliSessionIds: [...new Set(cliIds)],
    title: str(raw.title) ?? 'Untitled session',
    cwd: str(raw.cwd),
    createdAt: num(raw.createdAt),
    lastActivityAt: num(raw.lastActivityAt) ?? fileMtime,
    lastTurnEdgeAt,
    isMidTurn,
    midTurnSource: isMidTurn ? 'user-frame' : null,
    turnStartedAt: (typedAt ?? 0) > lastTurnEdgeAt ? typedAt : startingAt ?? typedAt,
    model: str(raw.model),
    effort: str(raw.effort),
    permissionMode: str(raw.permissionMode),
    completedTurns: num(raw.completedTurns),
    gitRoot: str(anchor?.gitRoot),
    commonDir: str(anchor?.commonDir),
    prs: parsePrs(raw.prs),
    writtenBranches: branches,
    summary: {
      category: str(summary.status_category),
      detail: str(summary.status_detail) ?? '',
      needsAction: str(summary.needs_action) ?? '',
    },
    isInterruptedAwaitingPerson: Boolean(raw.interruptedAwaitingPerson),
    isWaitingInput,
    waitingMarkedAt: markedAt ?? null,
    lastFocusedAt: num(raw.lastFocusedAt),
    remoteControl: remoteControlOf(raw),
    hasSuggestion: raw.hasPromptSuggestion === true || promptSuggestionOf(raw) !== null,
    parent: parentOf(raw, localId),
    lastReport: reportOf(raw, lastTurnEdgeAt),
    failure: failureOf(raw, lastTurnEdgeAt),
  }
}

export const TURN_EDGE_SLACK_MS = 5_000

/**
 * The desktop writes a `waiting-input` marker for a new or woken session
 * from its creation until its CLI takes the first prompt, a few seconds
 * after the prompt was typed. A marker written no later than the open
 * turn's typed prompt (plus slack) is that start-up marker, not a question:
 * a real question comes after the model has run. A brand-new session's
 * marker comes first, before the desktop records the typed prompt at all:
 * with no prompt and no finished turn there is nothing to ask about yet.
 * The start-up marker reads as an open turn (the prompt was sent).
 * @param {RawSession} raw
 * @param {string} localId
 * @param {ReadonlySet<string> | ReadonlyMap<string, number | null>} waiting
 * @returns {boolean}
 */
function isWaitingOnPerson(raw, localId, waiting) {
  if (!waiting.has(localId)) return false
  const markedAt = waiting instanceof Map ? waiting.get(localId) ?? null : null
  const typedAt = num(raw.latestUserFrameAt)
  if (typedAt === null && !((num(raw.completedTurns) ?? 0) > 0)) return false
  if (markedAt === null || typedAt === null || typedAt <= (num(raw.lastTurnEdgeAt) ?? 0)) return true
  return markedAt > typedAt + TURN_EDGE_SLACK_MS
}

/**
 * What the aggregator learned about a desktop session's transcript: when the
 * file was last written, and the time of its last conversation entry
 * (`lastEntryAt` in `shared/conversation.js`) when the file could be read.
 * @typedef {object} TranscriptActivity
 * @property {number} writtenAt
 * @property {number | null} lastEntryAt
 * @property {boolean} isRead
 */

/**
 * The cheap first test: the transcript was written more than a few seconds
 * past the turn edge, within the stale window. Only then is the file read.
 * @param {DesktopSession} d
 * @param {number | null} writtenAt
 * @param {number} now
 * @param {number} staleMs
 * @returns {boolean}
 */
export function isWrittenPastEdge(d, writtenAt, now, staleMs) {
  return writtenAt !== null && !d.isMidTurn && writtenAt > d.lastTurnEdgeAt + TURN_EDGE_SLACK_MS && now - writtenAt <= staleMs
}

/**
 * The desktop record moves `lastTurnEdgeAt` when a turn starts as well as when
 * it ends, and `latestUserFrameAt` only on typed prompts, so a turn started by
 * a notification or a queued message looks idle. While a turn runs, the
 * session's transcript keeps getting conversation entries after that edge.
 * Writes alone are not enough: a CLI that exits appends bookkeeping lines
 * (`last-prompt`, `cost-state`, system lines) long after its last turn. So a
 * turn is open only when the transcript was written past the edge and its
 * last conversation entry is too, and the session's publisher did not end at
 * or after that entry. A file that could not be read falls back to its write
 * time, with a few seconds of slack against the end.
 * @param {DesktopSession} d
 * @param {TranscriptActivity | null} activity
 * @param {number} now
 * @param {number} staleMs
 * @param {number | null} [endedAt]
 * @returns {DesktopSession}
 */
export function withTranscriptActivity(d, activity, now, staleMs, endedAt = null) {
  if (!activity || !isWrittenPastEdge(d, activity.writtenAt, now, staleMs)) return d
  const entryAt = activity.isRead ? activity.lastEntryAt : activity.writtenAt
  if (entryAt === null || entryAt <= d.lastTurnEdgeAt + TURN_EDGE_SLACK_MS) return d
  if (endedAt !== null && endedAt + (activity.isRead ? 0 : TURN_EDGE_SLACK_MS) >= entryAt) return d
  return {
    ...d,
    isMidTurn: true,
    midTurnSource: 'transcript',
    turnStartedAt: d.lastTurnEdgeAt || d.turnStartedAt,
    lastActivityAt: Math.max(d.lastActivityAt, activity.writtenAt),
  }
}

/**
 * Whether Remote Control is on: the record carries `remoteControlUserEnabled`
 * only once it was switched on, so its absence reads as off when the record
 * has the Remote Control fields at all, and as unknown when it has none.
 * @param {RawSession} raw
 * @returns {boolean | null}
 */
function remoteControlOf(raw) {
  if (typeof raw.remoteControlUserEnabled === 'boolean') return raw.remoteControlUserEnabled
  return typeof raw.remoteControlAutoEligible === 'boolean' ? false : null
}

/** @typedef {{ mtimeMs: number, raw: RawSession | null }} CacheEntry */

const RAW_KEYS = [
  'sessionId', 'isArchived', 'gitAnchors', 'postTurnSummary', 'lastTurnEdgeAt', 'writtenBranches', 'cliSessionId', 'lastAssistantCliSessionId', 'title', 'cwd', 'createdAt',
  'lastActivityAt', 'latestUserFrameAt', 'model', 'effort', 'permissionMode', 'completedTurns', 'prs', 'interruptedAwaitingPerson', 'lastFocusedAt', 'spawnedFrom',
  'forkedFromSessionId', 'lastTurnReport', 'turnWrapUp', 'errorCategory', 'errorAt', 'priorErrorMark', 'remoteControlUserEnabled', 'remoteControlAutoEligible',
]

/**
 * The fields `normalizeDesktop` reads, and the last crash only: a desktop
 * record averages about 70 KB, so whole records in the cache cost about
 * 10 MB (E-118).
 * @param {RawSession} raw
 * @returns {RawSession}
 */
function keptFields(raw) {
  /** @type {Record<string, unknown>} */
  const kept = {}
  const source = /** @type {Record<string, unknown>} */ (raw)
  for (const key of RAW_KEYS) if (key in source) kept[key] = source[key]
  if (Array.isArray(raw.queryCrashes) && raw.queryCrashes.length > 0) kept.queryCrashes = [raw.queryCrashes.at(-1)]
  if (promptSuggestionOf(raw) !== null) kept.hasPromptSuggestion = true
  return /** @type {RawSession} */ (kept)
}

/** @typedef {Map<string, CacheEntry>} DesktopCache */

/** @returns {DesktopCache} */
export function createDesktopCache() {
  return new Map()
}

/** @type {WeakMap<DesktopCache, DesktopSession[]>} */
const lastGoodScan = new WeakMap()

/**
 * Lists every desktop session record, newest first, and parses the newest
 * `maxSessions` of them; a file whose mtime has not moved is not read again.
 * @param {Host} $
 * @param {DesktopCache} cache
 * @param {string | null} root
 * @param {string} sep
 * @param {number} maxSessions
 * @param {ReadonlySet<string>} [keep]
 * @returns {Promise<DesktopScan>}
 */
export async function scanDesktop($, cache, root, sep, maxSessions, keep = new Set()) {
  /** @type {DesktopScan} */
  const result = { sessions: [], files: 0, parsed: 0, failed: 0, skipped: 0, error: null }
  if (!root) {
    result.error = 'APPDATA is not set'
    return result
  }
  try {
    if (!(await $.fs.exists(root))) {
      result.error = 'no desktop session folder (Claude desktop not installed here?)'
      return result
    }
    /** @type {{ path: string, mtimeMs: number, waiting: Map<string, number | null> }[]} */
    const candidates = []
    for (const account of await $.fs.list(root)) {
      if (account.kind !== 'dir') continue
      for (const org of await $.fs.list(joinWith(sep, root, account.name))) {
        if (org.kind !== 'dir') continue
        const folder = joinWith(sep, root, account.name, org.name)
        const entries = await $.fs.list(folder)
        /** @type {Map<string, number | null>} */
        const waiting = new Map()
        if (entries.some(e => e.name === 'waiting-input' && e.kind === 'dir')) {
          for (const entry of await $.fs.list(joinWith(sep, folder, 'waiting-input'))) {
            const match = entry.name.match(/local_[0-9a-f-]+/)
            if (match) waiting.set(match[0], typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : null)
          }
        }
        for (const entry of entries) {
          if (entry.kind !== 'file' || !/^local_.*\.json$/.test(entry.name)) continue
          result.files += 1
          candidates.push({ path: joinWith(sep, folder, entry.name), mtimeMs: entry.mtimeMs, waiting })
        }
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    /** @type {Set<string>} */
    const seen = new Set()
    for (const candidate of candidates) {
      const isKept = keep.has(candidate.path.split(/[\\/]/).at(-1)?.replace(/\.json$/, '') ?? '')
      if (result.sessions.length >= maxSessions && !isKept) {
        result.skipped += 1
        continue
      }
      seen.add(candidate.path)
      let entry = cache.get(candidate.path)
      if (!entry || entry.mtimeMs !== candidate.mtimeMs) {
        /** @type {RawSession | null} */
        let raw = null
        try {
          raw = keptFields(/** @type {RawSession} */ (JSON.parse(await $.fs.read(candidate.path))))
        } catch {
          raw = null
        }
        entry = { mtimeMs: candidate.mtimeMs, raw }
        if (raw) cache.set(candidate.path, entry)
        else cache.delete(candidate.path)
      }
      if (!entry.raw) {
        result.failed += 1
        continue
      }
      result.parsed += 1
      const session = normalizeDesktop(entry.raw, candidate.mtimeMs, candidate.waiting)
      if (session) result.sessions.push(session)
    }
    for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key)
    lastGoodScan.set(cache, result.sessions)
  } catch (error) {
    result.error = errorText(error)
    result.sessions = lastGoodScan.get(cache) ?? result.sessions
  }
  return result
}
