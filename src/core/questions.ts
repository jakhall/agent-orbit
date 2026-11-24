import type { EngineInterface } from 'claude-code'

import { inbox, serverCall, serverOf, type Server } from './inbox'

const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])
const POLL_WAIT_MS = 5_000

type Held = { engaged?: unknown; id?: unknown; nonce?: unknown }
type Waited = { status?: unknown; result?: unknown; message?: unknown }
type Ticket = { id: string; nonce: string }
type FromOrbit = { kind: 'answer'; result: Record<string, unknown> } | { kind: 'dismiss'; message: string }
type First<R> = { from: 'claude'; result: R } | { from: 'orbit'; answer: FromOrbit | null }

/** The AskUserQuestion arguments in a `tool.call` input, without the engine's reserved keys. */
export function questionInput(e: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED.has(key)))
}

/** Whether a server's answer is an answered AskUserQuestion input: an object whose `answers` are all text. */
export function isQuestionResult(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const answers = (value as { answers?: unknown }).answers
  return !!answers && typeof answers === 'object' && !Array.isArray(answers) && Object.values(answers).every(a => typeof a === 'string')
}

/** What the model reads when the person dismissed the question in Orbit by writing a message instead. */
export function dismissedText(message: string): string {
  return `The user dismissed this question without choosing an option and wrote instead:\n\n${message}`
}

async function waitForOrbit($: EngineInterface, server: Server, ticket: Ticket, isSettled: () => boolean): Promise<FromOrbit | null> {
  while (!isSettled()) {
    const waited = await serverCall<Waited>($, server, 'GET', `/api/hook/requests/${ticket.id}?nonce=${ticket.nonce}&waitMs=${POLL_WAIT_MS}`)
    if (isSettled() || !waited) return null
    if (waited.status === 'dismissed') return typeof waited.message === 'string' && waited.message.trim() ? { kind: 'dismiss', message: waited.message } : null
    if (waited.status === 'answered') return isQuestionResult(waited.result) ? { kind: 'answer', result: waited.result } : null
  }
  return null
}

/**
 * Asks one AskUserQuestion in Claude's dialog and in Orbit at once (2.1.6):
 * the server holds the question while this session polls for it, `next(e)`
 * opens Claude's own dialog, and the first answer wins. An Orbit answer
 * comes back as the tool's result, which settles the call and abandons the
 * dialog beneath; a Claude answer ends the held copy. With no server, a
 * refusal or any failure the dialog alone answers, as before. A message
 * sent from Orbit instead of an answer dismisses the question: the model
 * reads it as the tool's refusal and carries on with the message.
 */
export async function askBoth<R>($: EngineInterface, e: Record<string, unknown>, next: () => Promise<R>): Promise<R | { result: Record<string, unknown> } | { deny: string }> {
  const server = inbox.me ? await serverOf($) : null
  const held = server
    ? await serverCall<Held>($, server, 'POST', '/api/mod/questions', { cliSessionId: inbox.me, toolInput: questionInput(e), agentId: typeof e.agentId === 'string' ? e.agentId : null })
    : null
  if (!server || held?.engaged !== true || typeof held.id !== 'string' || typeof held.nonce !== 'string') return next()
  const ticket: Ticket = { id: held.id, nonce: held.nonce }
  let isSettled = false
  const inClaude = next()
  const first = await Promise.race<First<R>>([
    inClaude.then(result => ({ from: 'claude', result }) as const),
    waitForOrbit($, server, ticket, () => isSettled).then(answer => ({ from: 'orbit', answer }) as const),
  ]).catch(error => {
    isSettled = true
    void serverCall($, server, 'POST', `/api/hook/requests/${ticket.id}/end`, { nonce: ticket.nonce, outcome: 'stopped' })
    throw error
  })
  isSettled = true
  if (first.from === 'orbit' && first.answer?.kind === 'dismiss') {
    $.ui.log(`orbit: question ${ticket.id} dismissed in Orbit with a message`, { to: 'debug' })
    return { deny: dismissedText(first.answer.message) }
  }
  if (first.from === 'orbit' && first.answer?.kind === 'answer') {
    $.ui.log(`orbit: question ${ticket.id} answered in Orbit`, { to: 'debug' })
    return { result: first.answer.result }
  }
  if (first.from === 'claude') {
    void serverCall($, server, 'POST', `/api/hook/requests/${ticket.id}/end`, { nonce: ticket.nonce, outcome: 'answered in Claude' })
    return first.result
  }
  return inClaude
}
