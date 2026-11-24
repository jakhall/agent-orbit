import { checkReplyText, isAgentId, isPlainId } from '../../shared/inbox.js'
import { REPLY_PROTOCOL } from './replies.mjs'
import { STOP_PROTOCOL } from './stops.mjs'
import { log, readSnapshotForApi } from './runtime.mjs'

export let replyQueue = null
export let stopQueue = null
export let commandStore = null
let liveArm = null
let liveAudit = null
const WITHDRAW_WAIT_MS = 5_000

/** True while the page has Replies as me armed. */
export function isRepliesArmed() {
  return liveArm?.isArmed('replies') === true
}

export function bindReplies(queue, arm, audit, stops = null, commands = null) {
  replyQueue = queue
  commandStore = commands
  stopQueue = stops
  liveArm = arm
  liveAudit = audit
}

async function reachableSession(sessionKey) {
  if (typeof sessionKey !== 'string' || sessionKey === '' || sessionKey.length > 600) return { error: { status: 400, body: { error: 'a session key is needed' } } }
  const read = await readSnapshotForApi()
  if (read.error) return { error: read.error }
  const sessions = Array.isArray(read.snapshot?.sessions) ? read.snapshot.sessions : []
  const session = sessions.find(s => s && s.key === sessionKey)
  if (!session) return { error: { status: 404, body: { error: 'This session is no longer in Orbit.' } } }
  if (!isPlainId(session.cliSessionId)) return { error: { status: 400, body: { error: 'This session has no Claude Code id, so Orbit cannot reach it.' } } }
  return { session, snapshot: read.snapshot }
}

export const AGENT_PROTOCOL = 1

/** The sub-agent `body.agentId` names, when it is one of this session's and its mod can reach sub-agents; `agentId: null` when the body names none. */
function targetAgent(body, session, snapshot) {
  if (body?.agentId === undefined || body?.agentId === null) return { agentId: null }
  if (!isAgentId(body.agentId)) return { error: { status: 400, body: { error: 'not a sub-agent id' } } }
  const agents = Array.isArray(snapshot?.agents) ? snapshot.agents : []
  if (!agents.some(a => a && a.key === `${session.key}/${body.agentId}`)) return { error: { status: 404, body: { error: 'This sub-agent is no longer in Orbit.' } } }
  if (session.publisher?.agentProtocol !== AGENT_PROTOCOL) return { error: { status: 409, body: { error: 'That session runs an older Orbit, which cannot reach its sub-agents; open it in Claude instead.', older: true } } }
  return { agentId: body.agentId }
}

export async function queueReply(body) {
  const first = checkReplyText(body.text)
  if (!first.ok && first.reason !== 'command') return { status: 400, body: { error: first.error, reason: first.reason } }
  const { session, snapshot, error } = await reachableSession(body.sessionKey)
  if (error) return error
  const target = targetAgent(body, session, snapshot)
  if (target.error) return target.error
  const agentId = target.agentId
  if (agentId && !first.ok) return { status: 400, body: { error: 'A sub-agent takes messages, not slash commands.', reason: first.reason } }
  const checked = first.ok ? first : checkReplyText(body.text, commandStore?.namesFor(session.cliSessionId) ?? null)
  if (!checked.ok) return { status: 400, body: { error: checked.error, reason: checked.reason } }
  if (session.publisher?.replyProtocol !== REPLY_PROTOCOL) return { status: 409, body: { error: 'That session runs an older Orbit, which cannot take replies from this one; start a new session to reply to it.', older: true } }
  if (!liveArm?.isArmed('replies')) return { status: 409, body: { error: 'Replies from Orbit are off: arm them first.', reason: 'not-armed' } }
  const command = checked.command ?? null
  const { id, createdAt } = replyQueue.queue({ cli: session.cliSessionId, text: checked.text, command: command !== null, agentId })
  if (agentId) {
    log(`queued reply ${id} for sub-agent ${agentId.slice(0, 8)} of session ${session.cliSessionId.slice(0, 8)}`)
    liveAudit?.record({ kind: 'reply', id, session: session.cliSessionId, agent: agentId, outcome: 'queued' })
  } else if (command) {
    log(`queued command /${command.name} ${id} for session ${session.cliSessionId.slice(0, 8)}`)
    liveAudit?.record({ kind: 'command', id, session: session.cliSessionId, what: command.name })
  } else log(`queued reply ${id} for session ${session.cliSessionId.slice(0, 8)}`)
  return { status: 200, body: { ok: true, id, createdAt, ...(command ? { command: command.name } : {}) } }
}

/** The slash commands Orbit may run in one session, for the page's `/` menu; `known` is false when its mod published none lately. */
export async function sessionCommands(sessionKey) {
  const { session, error } = await reachableSession(sessionKey)
  if (error) return error
  const list = commandStore?.listFor(session.cliSessionId) ?? null
  return { status: 200, body: { known: list !== null, commands: list ?? [] } }
}

export function replyResult(id) {
  const entry = replyQueue?.entries.get(id)
  const session = entry?.cli
  const agent = entry?.agentId ?? undefined
  const answer = replyQueue?.result(id) ?? null
  if (!answer) return { status: 404, body: { error: 'Orbit no longer tracks this reply.' } }
  if (answer.status !== 'pending') {
    log(`reply ${id} ${answer.status}${answer.reason ? ` (${answer.reason})` : ''}`)
    liveAudit?.record({ kind: 'reply', id, session, agent, outcome: answer.reason ? `${answer.status}: ${answer.reason}` : answer.status })
  }
  return { status: 200, body: answer }
}

export function logExpiredReplies(now) {
  for (const id of replyQueue?.expired(now) ?? []) log(`reply ${id} expired: no acknowledgement`)
}

export function setReplyWait(id, body) {
  if (typeof body?.wait !== 'boolean') return { status: 400, body: { error: 'wait must be true or false' } }
  if (!replyQueue?.setWait(id, body.wait)) return { status: 409, body: { error: 'This message already went or was withdrawn.' } }
  log(`reply ${id} ${body.wait ? 'waits for the turn to end' : 'steers into the turn'}`)
  return { status: 200, body: { ok: true, wait: body.wait } }
}

export async function withdrawReply(id) {
  if (!replyQueue) return { status: 404, body: { error: 'Orbit no longer tracks this reply.' } }
  const until = Date.now() + WITHDRAW_WAIT_MS
  let outcome = replyQueue.withdraw(id, false)
  if (outcome === null) return { status: 404, body: { error: 'Orbit no longer tracks this reply.' } }
  while (outcome?.verdict === 'wait') {
    await new Promise(r => setTimeout(r, 250))
    outcome = replyQueue.withdraw(id, Date.now() >= until)
  }
  const verdict = outcome?.verdict ?? 'unknown'
  log(`reply ${id} withdrawal: ${verdict}`)
  liveAudit?.record({ kind: 'reply', id, outcome: `withdrawal: ${verdict}` })
  return { status: 200, body: verdict === 'delivered' && outcome?.ack ? outcome.ack : { status: verdict } }
}

export async function requestStop(body) {
  const { session, snapshot, error } = await reachableSession(body?.sessionKey)
  if (error) return error
  const target = targetAgent(body, session, snapshot)
  if (target.error) return target.error
  if (session.publisher?.stopProtocol !== STOP_PROTOCOL || !stopQueue) return { status: 409, body: { error: 'That session runs an older Orbit, which cannot be stopped from here; open it in Claude to stop it.', older: true } }
  if (!liveArm?.isArmed('replies')) return { status: 409, body: { error: 'Replies as me are off, so Orbit cannot stop sessions: turn them on first.', reason: 'not-armed' } }
  const { id, createdAt } = stopQueue.request(session.cliSessionId, target.agentId)
  log(`stop ${id} requested for ${target.agentId ? `sub-agent ${target.agentId.slice(0, 8)} of ` : ''}session ${session.cliSessionId.slice(0, 8)}`)
  liveAudit?.record({ kind: 'stop', id, session: session.cliSessionId, ...(target.agentId ? { agent: target.agentId } : {}), outcome: 'requested' })
  return { status: 200, body: { ok: true, id, createdAt } }
}

export function stopResult(id) {
  const entry = stopQueue?.entries.get(id)
  const session = entry?.cli
  const agent = entry?.agentId ?? undefined
  const answer = stopQueue?.result(id) ?? null
  if (!answer) return { status: 404, body: { error: 'Orbit no longer tracks this stop.' } }
  if (answer.status !== 'pending') {
    log(`stop ${id} ${answer.status}`)
    liveAudit?.record({ kind: 'stop', id, session, agent, outcome: answer.status })
  }
  return { status: 200, body: answer }
}

/** What one session's mod may take now: its replies, and its stop requests while replies are armed. */
export function modPending(cli) {
  const pending = replyQueue.pendingFor(cli)
  return pending.armed && stopQueue ? { ...pending, stops: stopQueue.pendingFor(cli) } : pending
}

export function logExpiredStops(now) {
  for (const id of stopQueue?.expired(now) ?? []) log(`stop ${id} expired: the session did not take it`)
}
