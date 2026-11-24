import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'

import { APPROVAL_BEHAVIORS, APPROVAL_WAIT_MS, QUESTION_BEHAVIORS, QUESTION_TOOL, QUESTION_WAIT_MAX_MS, approvalRequest, approvalView, checkAnswerPost, checkQuestionAnswer, hashText, isQuestionRequest, questionResult, readQuestions, readRequest } from '../../shared/approvals.js'

export const MARKER_MS = 30 * 60_000
export const LONG_POLL_MS = 20_000
export const EXTEND_MS = 60_000
export const HELD_MAX_MS = 30 * 60_000
export const HELD_LEASE_MS = 45_000
const ENDED_KEEP = 200
const CLOCK_SLACK_MS = 5_000
const OPEN_PER_SESSION = 20
const OPEN_MAX = 100
const MARKERS_MAX = 500

/** @param {unknown} given @param {string} expected */
function sameNonce(given, expected) {
  if (typeof given !== 'string' || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}

/**
 * @param {any} request
 * @returns {boolean}
 */
function isIntact(request) {
  if (request.truncated) return true
  return createHash('sha256').update(hashText(request.toolName, request.toolInput)).digest('hex') === request.inputHash
}

/**
 * Approval and question requests held in the server's memory (A5, E-01):
 * the hook registers each one with a nonce it keeps; the server decides
 * whether Orbit engages (`isEngaged`), keeps the answer in memory, and hands
 * it only to the caller with that nonce. Files are never read. Every
 * registration also leaves a text-free wait marker (session, tool, time) so
 * a prompt shows as Needs you even when Orbit does not engage (E-06).
 * A held question (`hold`) is one a session's own mod raised while Claude's
 * dialog shows the same question: it waits while the mod keeps polling (a
 * lease, up to `HELD_MAX_MS`), whether or not a window is open, and the
 * hook's copy of it stays a marker only.
 * @param {{ now?: () => number, isEngaged: (request: any) => boolean, isHeldEngaged?: (request: any) => boolean, onChange?: () => void, log?: (line: string) => void, onFinish?: (request: any, outcome: string) => void, isHookAlive?: (pid: number) => boolean }} io
 */
export function createRequestStore({ now = Date.now, isEngaged, isHeldEngaged = () => false, onChange = () => undefined, log = () => undefined, onFinish = () => undefined, isHookAlive = () => true }) {
  /** @type {Map<string, { request: any, nonce: string, answer: any, outcome: string | null, waiters: Set<() => void>, leaseUntil?: number }>} */
  const open = new Map()
  /** @type {Map<string, { kind: 'permission' | 'question', toolName: string, createdAt: number }>} */
  const markers = new Map()
  /** @type {Set<string>} */
  const ended = new Set()
  let version = 0
  const changed = () => {
    version += 1
    onChange()
  }

  function finish(id, outcome) {
    const entry = open.get(id)
    if (!entry) return
    open.delete(id)
    ended.add(id)
    if (ended.size > ENDED_KEEP) ended.delete(ended.values().next().value)
    if (isQuestionRequest(entry.request)) log(`question ${id} ${outcome}`)
    else log(`approval ${id} ${outcome}`)
    onFinish(entry.request, outcome)
    for (const wake of entry.waiters) wake()
    changed()
  }

  return {
    /**
     * @param {unknown} body `{ request, nonce }` from the hook, or `{ marker: { cliSessionId, toolName }, nonce }`
     * @returns {{ status: number, body: object }}
     */
    register(body) {
      const b = /** @type {any} */ (body)
      const nonce = typeof b?.nonce === 'string' && /^[0-9a-f-]{16,64}$/i.test(b.nonce) ? b.nonce : null
      if (!nonce) return { status: 400, body: { error: 'a nonce is needed' } }
      const at = now()
      if (b.marker) {
        const cli = typeof b.marker.cliSessionId === 'string' ? b.marker.cliSessionId.slice(0, 100) : ''
        if (!cli) return { status: 400, body: { error: 'a session id is needed' } }
        markers.delete(cli)
        markers.set(cli, { kind: b.marker.toolName === 'AskUserQuestion' ? 'question' : 'permission', toolName: String(b.marker.toolName ?? '').slice(0, 60), createdAt: at })
        while (markers.size > MARKERS_MAX) markers.delete(markers.keys().next().value)
        changed()
        return { status: 200, body: { engaged: false } }
      }
      const request = readRequest(b.request)
      if (!request || !isIntact(request)) return { status: 400, body: { error: 'not a request Orbit can show' } }
      if (Math.abs(request.createdAt - at) > CLOCK_SLACK_MS || request.expiresAt - request.createdAt > APPROVAL_WAIT_MS || !isHookAlive(request.hookPid)) return { status: 400, body: { error: 'not a request a live hook just made' } }
      if (request.expiresAt <= at || open.has(request.id) || ended.has(request.id)) return { status: 409, body: { error: 'this request is expired or known' } }
      const openForSession = [...open.values()].filter(e => e.request.cliSessionId === request.cliSessionId).length
      if (openForSession >= OPEN_PER_SESSION || open.size >= OPEN_MAX) return { status: 429, body: { error: 'too many open requests' } }
      markers.set(request.cliSessionId, { kind: isQuestionRequest(request) ? 'question' : 'permission', toolName: String(request.toolName).slice(0, 60), createdAt: at })
      const isHeldElsewhere = isQuestionRequest(request) && [...open.values()].some(e => e.request.held === true && e.request.cliSessionId === request.cliSessionId)
      if (isHeldElsewhere || !isEngaged(request)) {
        changed()
        return { status: 200, body: { engaged: false } }
      }
      open.set(request.id, { request, nonce, answer: null, outcome: null, waiters: new Set() })
      changed()
      return { status: 200, body: { engaged: true, id: request.id } }
    },

    /**
     * A session's mod holds a question it is asking in Claude too:
     * `{ cliSessionId, toolInput, agentId?, cwd? }`. Engaged ones get an id
     * and a nonce only the mod holds; it then long-polls `wait` as the hook does.
     * @param {unknown} body
     * @returns {{ status: number, body: object }}
     */
    hold(body) {
      const b = /** @type {any} */ (body)
      const at = now()
      const toolInput = b?.toolInput ?? null
      const inputHash = createHash('sha256').update(hashText(QUESTION_TOOL, toolInput)).digest('hex')
      const id = randomUUID()
      const made = approvalRequest(
        { tool_name: QUESTION_TOOL, session_id: b?.cliSessionId, tool_input: toolInput, cwd: b?.cwd },
        { id, now: at, inputHash, hookPid: 0, waitMs: HELD_MAX_MS, agentId: typeof b?.agentId === 'string' ? b.agentId.slice(0, 100) : null },
      )
      if (!made) return { status: 400, body: { error: 'not a question Orbit can show' } }
      const request = { ...made, held: true }
      const openForSession = [...open.values()].filter(e => e.request.cliSessionId === request.cliSessionId).length
      if (openForSession >= OPEN_PER_SESSION || open.size >= OPEN_MAX) return { status: 429, body: { error: 'too many open requests' } }
      if (!isHeldEngaged(request)) return { status: 200, body: { engaged: false } }
      const nonce = randomUUID()
      open.set(id, { request, nonce, answer: null, outcome: null, waiters: new Set(), leaseUntil: at + HELD_LEASE_MS })
      log(`question ${id} held`)
      changed()
      return { status: 200, body: { engaged: true, id, nonce } }
    },

    /**
     * The hook's long poll: resolves with the answer as soon as there is one.
     * @param {string} id
     * @param {unknown} nonce
     * @param {number} maxMs
     */
    async wait(id, nonce, maxMs) {
      const entry = open.get(id)
      if (!entry) return { status: 410, body: { status: 'gone' } }
      if (!sameNonce(nonce, entry.nonce)) return { status: 403, body: { error: 'not this request' } }
      const isHeld = entry.request.held === true
      if (isHeld) entry.leaseUntil = now() + HELD_LEASE_MS + Math.min(maxMs, LONG_POLL_MS)
      if (!entry.answer) {
        await new Promise(resolve => {
          const timer = setTimeout(done, Math.max(0, Math.min(maxMs, LONG_POLL_MS)))
          function done() {
            clearTimeout(timer)
            entry.waiters.delete(done)
            resolve(undefined)
          }
          entry.waiters.add(done)
        })
      }
      if (entry.answer) {
        const answer = entry.answer
        finish(id, isQuestionRequest(entry.request) ? ({ answer: 'answered', dismiss: 'dismissed' }[answer.behavior] ?? 'declined') : `answered: ${answer.behavior}`)
        if (isHeld) return { status: 200, body: answer.behavior === 'dismiss' ? { status: 'dismissed', answer, message: answer.message } : { status: 'answered', answer, result: heldResult(entry.request, answer) } }
        return { status: 200, body: { status: 'answered', answer } }
      }
      return open.has(id) ? { status: 200, body: { status: 'pending', expiresAt: entry.request.expiresAt } } : { status: 410, body: { status: 'gone' } }
    },

    /**
     * Someone is typing an answer to a question (E-23): it stays open for
     * another minute, never past `QUESTION_WAIT_MAX_MS` from when it was asked. The
     * hook learns the new deadline on its next poll.
     */
    extend(id) {
      const entry = open.get(id)
      if (!entry) return { status: 404, body: { error: 'This request is no longer waiting.' } }
      if (!isQuestionRequest(entry.request)) return { status: 400, body: { error: 'only a question waits for typing' } }
      const expiresAt = Math.max(entry.request.expiresAt, Math.min(entry.request.createdAt + QUESTION_WAIT_MAX_MS, now() + EXTEND_MS))
      entry.request = { ...entry.request, expiresAt }
      changed()
      return { status: 200, body: { ok: true, expiresAt } }
    },

    /** The hook says it stopped waiting (expired, stopped). */
    end(id, nonce, outcome) {
      const entry = open.get(id)
      if (!entry) return { status: 410, body: { status: 'gone' } }
      if (!sameNonce(nonce, entry.nonce)) return { status: 403, body: { error: 'not this request' } }
      finish(id, ['expired', 'stopped', 'answered in Claude'].includes(outcome) ? outcome : 'ended')
      return { status: 200, body: { ok: true } }
    },

    /** A window's answer, checked as before (`checkAnswerPost`). */
    answer(id, body) {
      const entry = open.get(id)
      if (!entry) return { status: 404, body: { error: 'This request is no longer waiting.' } }
      if (entry.answer) return { status: 409, body: { error: 'This request was already answered.' } }
      const at = now()
      const checked = checkAnswerPost(body, entry.request, at)
      if (!checked.ok) return { status: checked.status, body: { error: checked.error } }
      entry.answer = { schema: 1, id, inputHash: entry.request.inputHash, behavior: checked.behavior, at }
      if (checked.behavior === 'answer') Object.assign(entry.answer, { answers: checked.answers, notes: checked.notes })
      if (checked.behavior === 'dismiss') entry.answer.message = checked.message
      for (const wake of entry.waiters) wake()
      changed()
      return { status: 200, body: { ok: true, behavior: checked.behavior } }
    },

    /** Requests the windows show: still open, not expired. */
    list() {
      const at = now()
      return [...open.values()]
        .filter(e => e.request.expiresAt > at)
        .map(e => {
          const behaviors = isQuestionRequest(e.request) ? QUESTION_BEHAVIORS : APPROVAL_BEHAVIORS
          return { ...approvalView(e.request), answered: e.answer && behaviors.includes(e.answer.behavior) ? e.answer.behavior : null }
        })
        .sort((a, b) => a.createdAt - b.createdAt)
    },

    /** Ends open requests past their expiry, and all of them when no window is left. */
    sweep({ isWindowGone }) {
      const at = now()
      for (const [id, entry] of [...open]) {
        if (entry.request.expiresAt <= at) finish(id, 'expired')
        else if (entry.request.held === true) {
          if ((entry.leaseUntil ?? 0) <= at) finish(id, 'mod-gone')
        } else if (isWindowGone && !entry.answer) finish(id, 'window-gone')
      }
      for (const [cli, marker] of [...markers]) if (at - marker.createdAt > MARKER_MS) markers.delete(cli)
    },

    /** Wait markers by CLI session id, for `status` (E-06): the newest per session. */
    markers() {
      return new Map([...markers].map(([cli, m]) => [cli, [m]]))
    },

    /** Drops a session's marker once its record moved past it. */
    clearMarker(cli) {
      if (markers.delete(cli)) changed()
    },

    stamp: () => version,
  }
}

/**
 * The AskUserQuestion result a held question's mod hands back for an
 * `answer`, or null for `ask` (Claude's dialog keeps it) or an answer that
 * no longer checks out against the question's own options.
 * @param {any} request
 * @param {any} answer
 */
function heldResult(request, answer) {
  if (answer.behavior !== 'answer') return null
  const questions = readQuestions(request.toolInput)
  const checked = questions ? checkQuestionAnswer(questions, { answers: answer.answers, notes: answer.notes }) : null
  return checked?.ok ? questionResult(request.toolInput, checked.answers, checked.notes) : null
}
