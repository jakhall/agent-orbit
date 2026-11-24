import type { EngineInterface, PromptSubmitResult, Timer } from 'claude-code'

import type { InboxStats, ReplyAck, ReplyRefusal } from '../../types'
import { countInbox, deliveryAck, isAgentId, judgeReply, publishableCommands, refusalAck, rememberId, SEEN_MAX, steerContext, SUBMIT_SETTLE_MS } from '../../shared/inbox.js'
import { isProven, newNonce, NONCE_HEADER, PROOF_HEADER } from '../../shared/proof.js'
import { errorText, joinWith, readJson, type Paths } from '../paths'
import { recordError } from '../telemetry/publisher'

const POLL_MS = 2_000
const IDLE_POLL_MS = 5_000
const FETCH_TIMEOUT_NOTE = 'the Orbit server did not answer'
const COMMANDS_EVERY_MS = 60_000

export type Server = { port: number; token: string }
type Pending = { armed?: unknown; replies?: unknown; stops?: unknown }
type MainTurn = { id: string; startedAt: number }
type HeldReply = { text: string; wait: boolean }
type Command = { name: string; args: string }
export type StopOutcome = 'stopped' | 'idle' | 'failed'

type Outcome = 'entered' | 'pending' | 'dropped' | 'threw'
type InboxEvent = { kind: 'delivered' } | { kind: 'refused'; reason: ReplyRefusal } | { kind: 'unqueued' }

/**
 * One session's replies: requests the Orbit server holds for it in memory,
 * fetched with the control token over `$.http.fetch` and delivered by this
 * session's own mod as the person's words with `$.prompt.submit({ asUser:
 * true })` (A5). Only its consumed-id memory is a file (`inbox/<its
 * cliSessionId>/seen.json`); counts and reasons are all that is published.
 * A reply that arrives mid-turn is held on the server (`held`, refreshed by
 * every poll) and steered into the turn after its next tool batch, or sent
 * once the turn ends when the person marked it to wait. A slash command the
 * session lists (published to the server as `commands`) is never steered:
 * it is run with `$.command.run` once the session is idle.
 */
export type InboxState = {
  paths: Paths | null
  me: string
  seen: string[]
  polls: number
  isPolling: boolean
  isTurnRunning: boolean
  turn: MainTurn | null
  held: Map<string, HeldReply>
  commands: Set<string> | null
  commandsAt: number
  stats: InboxStats | null
  timer: Timer | null
  loop: number
  isActive: boolean
  onStats: ((stats: InboxStats) => void) | null
}

export const inbox: InboxState = {
  paths: null,
  me: '',
  seen: [],
  polls: 0,
  isPolling: false,
  isTurnRunning: false,
  turn: null,
  held: new Map(),
  commands: null,
  commandsAt: 0,
  stats: null,
  timer: null,
  loop: 0,
  isActive: false,
  onStats: null,
}

/**
 * Sets (or resets) whose inbox this is. `me` is the session's
 * `cliSessionId`, given again after a `/clear` or restart changes it.
 * Polling runs only while `inboxSetActive` says a pop-out server is live.
 */
export function inboxStart($: EngineInterface, paths: Paths, me: string, onStats: (stats: InboxStats) => void): void {
  inbox.paths = paths
  inbox.onStats = onStats
  if (me !== inbox.me) {
    inbox.me = me
    inbox.seen = []
    inbox.polls = 0
    inbox.commands = null
    inbox.commandsAt = 0
  }
  if (inbox.isActive) restartPolling($)
}

/**
 * Polls this session's inbox (every 2 s while it has an inbox folder, every
 * 5 s while it has none) only while a pop-out server is live: only that
 * server writes reply requests, so with none there is nothing to read.
 */
export function inboxSetActive($: EngineInterface, isActive: boolean): void {
  if (isActive === inbox.isActive) return
  inbox.isActive = isActive
  if (isActive && inbox.paths) restartPolling($)
  else inboxStop()
}

function restartPolling($: EngineInterface): void {
  inbox.timer?.cancel()
  inbox.loop += 1
  const loop = inbox.loop
  inbox.timer = $.clock.after(0, () => void pollInbox($, loop))
}

export function inboxStop(): void {
  inbox.timer?.cancel()
  inbox.timer = null
  inbox.loop += 1
}

/** Whether the main loop is mid-turn (a reply delivered now is queued until it ends), and which turn a stop would abort. */
export function inboxTurn(isRunning: boolean, turnId?: string, at: number = Date.now()): void {
  inbox.isTurnRunning = isRunning
  if (isRunning && turnId) inbox.turn = { id: turnId, startedAt: at }
  else if (!isRunning && (!turnId || inbox.turn?.id === turnId)) inbox.turn = null
  if (!isRunning) inbox.held.clear()
}

/**
 * Aborts the main loop's running turn for a stop the page asked for at
 * `requestedAt`: a turn that began after the request (the old one ended and
 * a queued message started another) is left running.
 */
export async function stopTurn($: EngineInterface, requestedAt: number): Promise<StopOutcome> {
  const turn = inbox.turn
  if (!turn || turn.startedAt > requestedAt) return 'idle'
  try {
    await $.turn.abort({ turnId: turn.id })
    return 'stopped'
  } catch (error) {
    if (inbox.turn?.id !== turn.id) return 'idle'
    await recordError($, 'inbox', error).catch(() => undefined)
    return 'failed'
  }
}

/** Stops one of this session's sub-agents through TaskStop; a foreground sub-agent may refuse, which is `failed`. */
export async function stopAgent($: EngineInterface, agentId: string): Promise<StopOutcome> {
  try {
    const answer = await $.tool.call({ tool: 'TaskStop', task_id: agentId })
    return 'deny' in answer && typeof answer.deny === 'string' ? 'failed' : answer.isError ? 'failed' : 'stopped'
  } catch (error) {
    await recordError($, 'inbox', error).catch(() => undefined)
    return 'failed'
  }
}

function asStop(raw: unknown): { id: string; createdAt: number; agentId: string | null } | null {
  const s = raw as { id?: unknown; createdAt?: unknown; agentId?: unknown } | null
  if (!s || typeof s.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(s.id) || typeof s.createdAt !== 'number' || !Number.isFinite(s.createdAt)) return null
  if (s.agentId !== undefined && !isAgentId(s.agentId)) return null
  return { id: s.id, createdAt: s.createdAt, agentId: isAgentId(s.agentId) ? s.agentId : null }
}

async function handleStop($: EngineInterface, server: Server, raw: unknown): Promise<void> {
  const stop = asStop(raw)
  if (!stop) return
  const claim = await serverCall<{ ok?: unknown }>($, server, 'POST', `/api/mod/stops/${stop.id}/claim`, { cli: inbox.me })
  if (claim?.ok !== true) return
  const outcome = stop.agentId ? await stopAgent($, stop.agentId) : await stopTurn($, stop.createdAt)
  $.ui.log(`orbit: stop from Orbit${stop.agentId ? ' (sub-agent)' : ''}: ${outcome}`, { to: 'debug' })
  await serverCall($, server, 'POST', `/api/mod/stops/${stop.id}/ack`, { cli: inbox.me, outcome })
}

function sep(): string {
  return inbox.paths?.sep ?? '\\'
}

function dirOf(me: string): string {
  return joinWith(sep(), inbox.paths?.inboxDir ?? '', me)
}

async function loadSeen($: EngineInterface, dir: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await $.fs.read(joinWith(sep(), dir, 'seen.json'))) as { ids?: unknown }
    return Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => typeof id === 'string').slice(-SEEN_MAX) : []
  } catch {
    return []
  }
}

async function remember($: EngineInterface, dir: string, id: string): Promise<void> {
  inbox.seen = rememberId(inbox.seen, id)
  await $.fs.write(joinWith(sep(), dir, 'seen.json'), JSON.stringify({ ids: inbox.seen })).catch(() => undefined)
}

function count(event: InboxEvent, at: number): void {
  inbox.stats = countInbox(inbox.stats, event, at)
  inbox.onStats?.(inbox.stats)
}

export async function serverOf($: EngineInterface): Promise<Server | null> {
  if (!inbox.paths) return null
  const info = await readJson<{ port?: unknown; token?: unknown }>($, inbox.paths.companion)
  return info && typeof info.port === 'number' && typeof info.token === 'string' ? { port: info.port, token: info.token } : null
}

/**
 * One call to the Orbit server with the control token. The answer counts only
 * when it carries the proof for this call's nonce (docs/CONTRACT.md, Secrets):
 * anything else, a listener that took over the port included, reads as null.
 */
export async function serverCall<T>($: EngineInterface, server: Server, method: string, route: string, body?: unknown): Promise<T | null> {
  try {
    const nonce = newNonce()
    const answer = await $.http.fetch(`http://127.0.0.1:${server.port}${route}`, {
      method,
      headers: { 'x-orbit-token': server.token, [NONCE_HEADER]: nonce, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!answer.ok || !(await isProven(server.token, nonce, answer.headers?.[PROOF_HEADER]))) return null
    return JSON.parse(answer.text) as T
  } catch {
    return null
  }
}

async function writeAck($: EngineInterface, server: Server, ack: ReplyAck): Promise<void> {
  await serverCall($, server, 'POST', `/api/mod/replies/${ack.id}/ack`, { cli: inbox.me, ack })
}

function submit($: EngineInterface, text: string): Promise<PromptSubmitResult> {
  try {
    return $.prompt.submit({ text, asUser: true })
  } catch (error) {
    return Promise.reject(error)
  }
}

function runCommand($: EngineInterface, command: Command): Promise<PromptSubmitResult> {
  try {
    return $.command.run({ command: command.name, ...(command.args ? { args: command.args } : {}) } as never).then(() => ({}) as PromptSubmitResult)
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * Tells the server which slash commands Orbit may run in this session: the
 * session's own list minus the deny-list, names and short descriptions only.
 * Refreshed every minute while the server is live.
 */
async function publishCommands($: EngineInterface, server: Server, now: number): Promise<void> {
  if (inbox.commands && now - inbox.commandsAt < COMMANDS_EVERY_MS) return
  inbox.commandsAt = now
  const listed = await $.command.list().catch(() => null)
  if (!listed) return
  const allowed = publishableCommands(listed)
  inbox.commands = new Set(allowed.map(c => c.name))
  await serverCall($, server, 'POST', `/api/mod/commands/${inbox.me}`, {
    commands: allowed.map(c => ({ name: c.name, description: String(c.description ?? '').slice(0, 120), source: c.source })),
  })
}

function settle($: EngineInterface, submitting: Promise<PromptSubmitResult>): Promise<Outcome> {
  return new Promise(resolve => {
    const timer = $.clock.after(SUBMIT_SETTLE_MS, () => resolve('pending'))
    submitting.then(
      result => {
        timer.cancel()
        resolve(typeof result?.drop === 'string' ? 'dropped' : 'entered')
      },
      () => {
        timer.cancel()
        resolve('threw')
      },
    )
  })
}

/**
 * One request the server handed this session (A5, E-02): delivered only
 * while replies are armed (a launch's first prompt too), after the same
 * guards as before, claimed with the server before it is submitted, and
 * acknowledged there. Nothing is read from or written to inbox files except
 * this session's consumed-id memory.
 */
async function handleRequest($: EngineInterface, server: Server, dir: string, raw: unknown, isArmed: boolean): Promise<void> {
  const isFirstPrompt = (raw as { firstPrompt?: unknown } | null)?.firstPrompt === true
  if (!isArmed) return
  const now = await $.clock.now()
  const verdict = judgeReply(raw, { me: inbox.me, now, seen: new Set(inbox.seen), commands: inbox.commands })
  if (verdict.kind === 'skip') return
  if (verdict.kind === 'refuse') {
    count({ kind: 'refused', reason: verdict.reason }, now)
    if (!verdict.id) return
    if (verdict.reason !== 'replay') await remember($, dir, verdict.id)
    await writeAck($, server, refusalAck(verdict.id, verdict.reason, now))
    return
  }
  if (verdict.agentId) {
    await remember($, dir, verdict.id)
    const claim = await serverCall<{ ok?: unknown; reason?: unknown }>($, server, 'POST', `/api/mod/replies/${verdict.id}/claim`, { cli: inbox.me })
    if (claim?.ok !== true) {
      if (claim?.reason === 'withdrawn') await writeAck($, server, refusalAck(verdict.id, 'withdrawn', now))
      return
    }
    const sent = await $.session.send({ to: { agentId: verdict.agentId }, text: verdict.text }).catch(() => ({ isDelivered: false as const }))
    const ack = deliveryAck(verdict.id, sent.isDelivered ? 'entered' : 'dropped', false, await $.clock.now())
    count(ack.status === 'failed' ? { kind: 'refused', reason: 'dropped' } : { kind: 'delivered' }, ack.at)
    await writeAck($, server, ack)
    return
  }
  if (inbox.isTurnRunning && !isFirstPrompt) {
    const hold = verdict.held ? { ok: true } : await serverCall<{ ok?: unknown }>($, server, 'POST', `/api/mod/replies/${verdict.id}/hold`, { cli: inbox.me })
    if (hold?.ok === true && inbox.isTurnRunning) inbox.held.set(verdict.id, { text: verdict.text, wait: verdict.wait })
    return
  }
  await remember($, dir, verdict.id)
  const claim = await serverCall<{ ok?: unknown; reason?: unknown }>($, server, 'POST', `/api/mod/replies/${verdict.id}/claim`, { cli: inbox.me })
  if (claim?.ok !== true) {
    if (claim?.reason === 'withdrawn') {
      count({ kind: 'refused', reason: 'withdrawn' }, now)
      await writeAck($, server, refusalAck(verdict.id, 'withdrawn', now))
    }
    return
  }
  const isTurnRunning = inbox.isTurnRunning
  const submitting = verdict.command ? runCommand($, verdict.command) : submit($, verdict.text)
  const outcome = await settle($, submitting)
  const ack = deliveryAck(verdict.id, outcome, isTurnRunning, await $.clock.now())
  count(ack.status === 'failed' ? { kind: 'refused', reason: 'dropped' } : { kind: 'delivered' }, ack.at)
  await writeAck($, server, ack)
  if (outcome === 'pending') {
    void submitting.then(
      result => {
        if (typeof result?.drop === 'string') void $.clock.now().then(at => count({ kind: 'unqueued' }, at))
      },
      () => void $.clock.now().then(at => count({ kind: 'unqueued' }, at)),
    )
  }
}

/**
 * The hook context for the replies held for the running main turn that do
 * not wait for its end: each is claimed (a withdrawn one is refused there),
 * acknowledged as sent and handed to the model after the turn's tool batch.
 * Skipped while a poll runs, so a reply is never judged twice at once.
 */
export async function steerReplies($: EngineInterface): Promise<string[]> {
  if (!inbox.isTurnRunning || inbox.isPolling || !inbox.paths) return []
  const due = [...inbox.held].filter(([, reply]) => !reply.wait)
  if (due.length === 0) return []
  inbox.isPolling = true
  try {
    const server = await serverOf($)
    if (!server) return []
    const dir = dirOf(inbox.me)
    const steered: string[] = []
    for (const [id, reply] of due) {
      inbox.held.delete(id)
      const claim = await serverCall<{ ok?: unknown }>($, server, 'POST', `/api/mod/replies/${id}/claim`, { cli: inbox.me })
      if (claim?.ok !== true) continue
      await remember($, dir, id)
      steered.push(steerContext(reply.text))
      const at = await $.clock.now()
      count({ kind: 'delivered' }, at)
      await writeAck($, server, { id, status: 'sent', reason: null, at })
    }
    if (steered.length > 0) $.ui.log(`orbit: steered ${steered.length} reply(s) into the turn`, { to: 'debug' })
    return steered
  } catch (error) {
    await recordError($, 'inbox', error).catch(() => undefined)
    return []
  } finally {
    inbox.isPolling = false
  }
}

type Notice = { id: string; title: string; body: string }

function asNotice(raw: unknown): Notice | null {
  const n = raw as { id?: unknown; title?: unknown; body?: unknown } | null
  if (!n || typeof n.id !== 'string' || !/^[0-9a-z]{1,40}$/.test(n.id) || typeof n.title !== 'string' || typeof n.body !== 'string') return null
  return { id: n.id, title: n.title.slice(0, 120), body: n.body.slice(0, 200) }
}

/**
 * Raises the server's notices (G-20) through the person's own notification
 * channel. The server hands each to the first session that claims it, so
 * one notice shows once however many sessions run Orbit.
 */
async function raiseNotices($: EngineInterface, server: Server): Promise<void> {
  const pending = await serverCall<{ notices?: unknown }>($, server, 'GET', '/api/mod/notices')
  if (!pending || !Array.isArray(pending.notices)) return
  for (const raw of pending.notices.slice(0, 3)) {
    const notice = asNotice(raw)
    if (!notice) continue
    const claim = await serverCall<{ ok?: unknown }>($, server, 'POST', `/api/mod/notices/${notice.id}/claim`, { cli: inbox.me })
    if (claim?.ok !== true) continue
    let isSent = false
    let reason: string | null = null
    try {
      const sent = await $.ui.notify(notice.body, { title: notice.title, key: notice.id })
      isSent = sent.isSent === true
      reason = isSent ? null : String((sent as { reason?: unknown }).reason ?? '')
    } catch (error) {
      reason = 'threw'
      await recordError($, 'notice', error).catch(() => undefined)
    }
    await serverCall($, server, 'POST', `/api/mod/notices/${notice.id}/ack`, { cli: inbox.me, isSent, reason })
  }
}

async function pollInbox($: EngineInterface, loop: number): Promise<void> {
  let next = IDLE_POLL_MS
  if (loop !== inbox.loop) return
  if (!inbox.paths || !inbox.me || inbox.isPolling) {
    inbox.timer = $.clock.after(next, () => void pollInbox($, loop))
    return
  }
  inbox.isPolling = true
  try {
    const server = await serverOf($)
    const pending = server ? await serverCall<Pending>($, server, 'GET', `/api/mod/replies/${inbox.me}`) : null
    if (server && pending && Array.isArray(pending.replies)) {
      next = POLL_MS
      const dir = dirOf(inbox.me)
      if (inbox.polls === 0) inbox.seen = await loadSeen($, dir)
      inbox.polls += 1
      await publishCommands($, server, await $.clock.now())
      if (pending.armed === true && Array.isArray(pending.stops)) for (const raw of pending.stops.slice(0, 3)) await handleStop($, server, raw)
      inbox.held = new Map()
      for (const raw of pending.replies.slice(0, 20)) await handleRequest($, server, dir, raw, pending.armed === true)
      await raiseNotices($, server)
    } else if (server) {
      $.ui.log(`orbit: inbox: ${FETCH_TIMEOUT_NOTE}`, { to: 'debug' })
    }
  } catch (error) {
    $.ui.log(`orbit: inbox: ${errorText(error)}`, { to: 'debug' })
    await recordError($, 'inbox', error).catch(() => undefined)
  } finally {
    inbox.isPolling = false
    if (loop === inbox.loop) inbox.timer = $.clock.after(next, () => void pollInbox($, loop))
  }
}
