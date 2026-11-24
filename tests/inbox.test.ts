import { expect, test } from 'claude-code/testing'

import { MAX_MESSAGE_CHARS } from '../shared/constants.js'
import { checkReplyText, cleanInboxStats, countInbox, deliveryAck, inboxSummary, isDelivered, isPlainId, judgeReply, knownReason, refusalAck, rememberId, REPLY_TTL_MS, withdrawVerdict } from '../shared/inbox.js'
import { readOnlyText, REPLY_OLDER_TEXT, replyDeadline, sendAfterAck, sendBlock, sendMode, sendUpdate, withdrawOutcome, type Send } from '../shared/popout.js'
import { cleanRecord } from '../shared/aggregate/redact.js'
import { NOW, pub, session } from './fixtures'

const ch = (code: number) => String.fromCodePoint(code)

const ME = 'cli-11111111-2222-4333-8444-555555555555'
const ID = '0a1b2c3d-0000-4000-8000-00000000c0de'
const request = (patch: Record<string, unknown> = {}) => ({ schema: 1, id: ID, to: ME, text: 'Yes, go ahead', createdAt: NOW - 1_000, ...patch })
const judge = (raw: unknown, seen: string[] = []) => judgeReply(raw, { me: ME, now: NOW, seen: new Set(seen) })
const reasonOf = (text: unknown) => {
  const checked = checkReplyText(text)
  return checked.ok ? null : checked.reason
}

test('reply text: cleaned of invisible edges, refused when empty or too long', () => {
  expect(checkReplyText('  Yes, go ahead  ')).toEqual({ ok: true, text: 'Yes, go ahead' })
  expect(checkReplyText(`${ch(0x200b)}${ch(0x2060)} hello ${ch(0x200b)}\u0085`)).toEqual({ ok: true, text: 'hello' })
  expect([reasonOf('   '), reasonOf(`${ch(0x200b)}${ch(0x2060)}`), reasonOf(42)]).toEqual(['empty', 'empty', 'empty'])
  expect(reasonOf('x'.repeat(MAX_MESSAGE_CHARS + 1))).toBe('long')
  expect([checkReplyText('use a/b paths').ok, checkReplyText('issue #12 is fixed').ok, checkReplyText('yes!').ok, checkReplyText('🙂 thanks').ok]).toEqual([true, true, true, true])
})

test('reply text: slash, shell and memory commands are refused, also behind invisible characters or look-alikes', () => {
  const commands = [
    '/clear',
    '  /clear',
    `${ch(0x200b)}/clear`,
    '\u0085/clear',
    `${ch(0x2060)}/clear`,
    `${ch(0xfeff)}/clear`,
    '／clear',
    '∕clear',
    '⁄clear',
    '!echo hi',
    '！echo hi',
    '﹗echo hi',
    '#remember this',
    '＃remember this',
    '﹟remember this',
    '　#x',
  ]
  for (const text of commands) expect([text, reasonOf(text)]).toEqual([text, 'command'])
})

test('a request for a sub-agent is delivered to it straight away, never held, never a command; a bad agentId is refused', () => {
  expect(judge(request({ agentId: 'agent-a1', held: true, wait: true }))).toEqual({ kind: 'deliver', id: ID, text: 'Yes, go ahead', held: false, wait: false, agentId: 'agent-a1' })
  expect(judge(request({ agentId: 'agent a1' }))).toEqual({ kind: 'refuse', id: ID, reason: 'malformed' })
  expect(judge(request({ agentId: 7 }))).toEqual({ kind: 'refuse', id: ID, reason: 'malformed' })
  expect(judge(request({ agentId: 'agent-a1', text: '/compact' }))).toEqual({ kind: 'refuse', id: ID, reason: 'command' })
})

test('the mod delivers only a fresh, unseen, schema-1 request addressed to its own session, with acceptable text', () => {
  expect(judge(request())).toEqual({ kind: 'deliver', id: ID, text: 'Yes, go ahead', held: false, wait: false })
  expect(judge(request({ text: `${ch(0x200b)}Yes${ch(0x200b)}` }))).toEqual({ kind: 'deliver', id: ID, text: 'Yes', held: false, wait: false })
  expect(judge(request({ to: 'someone-else' }))).toEqual({ kind: 'refuse', id: ID, reason: 'wrong' })
  expect(judge(request({ schema: 2 }))).toEqual({ kind: 'refuse', id: ID, reason: 'malformed' })
  expect(judge(request({ schema: undefined }))).toEqual({ kind: 'refuse', id: ID, reason: 'malformed' })
  expect(judge(request({ createdAt: NOW - REPLY_TTL_MS - 1 }))).toEqual({ kind: 'refuse', id: ID, reason: 'stale' })
  expect(judge(request({ createdAt: NOW - REPLY_TTL_MS }))).toEqual({ kind: 'deliver', id: ID, text: 'Yes, go ahead', held: false, wait: false })
  expect(judge(request({ createdAt: NOW + 60_000 }))).toEqual({ kind: 'refuse', id: ID, reason: 'future' })
  expect(judge(request({ createdAt: 'yesterday' }))).toEqual({ kind: 'refuse', id: ID, reason: 'malformed' })
  expect(judge(request({ text: `${ch(0x200b)}/compact` }))).toEqual({ kind: 'refuse', id: ID, reason: 'command' })
  expect(judge(request({ text: '!rm -rf x' }))).toEqual({ kind: 'refuse', id: ID, reason: 'command' })
  expect(judge(request({ text: '' }))).toEqual({ kind: 'refuse', id: ID, reason: 'empty' })
  expect(judge(request({ text: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }))).toEqual({ kind: 'refuse', id: ID, reason: 'long' })
  expect(judge(request({ id: '../../escape' }))).toEqual({ kind: 'refuse', id: null, reason: 'malformed' })
  expect(judge(null)).toEqual({ kind: 'refuse', id: null, reason: 'malformed' })
  expect(judge(['x'])).toEqual({ kind: 'refuse', id: null, reason: 'malformed' })
})

test('request ids are one-shot: a consumed request is skipped, a replay of its id is refused; inbox file names are recognised', () => {
  expect(judge(request(), [ID])).toEqual({ kind: 'refuse', id: ID, reason: 'replay' })
  expect(judge({ id: ID, to: ME, createdAt: NOW, done: true }, [ID])).toEqual({ kind: 'skip' })
  expect(judge({ id: ID, to: ME, createdAt: NOW, done: true })).toEqual({ kind: 'skip' })
  const seen = Array.from({ length: 205 }, (_, i) => `id-${i}`).reduce<string[]>((list, id) => rememberId(list, id), [])
  expect(seen.length).toBe(200)
  expect(seen[0]).toBe('id-5')
  expect(rememberId(['a', 'b'], 'a')).toEqual(['b', 'a'])
  expect([isPlainId(ID), isPlainId('a/b'), isPlainId(''), isPlainId(7)]).toEqual([true, false, false, false])
})

test('the acknowledgement says queued while a turn runs, sent when idle, failed when the session did not take it; refusals carry their reason', () => {
  expect(deliveryAck(ID, 'entered', false, NOW)).toEqual({ id: ID, status: 'sent', reason: null, at: NOW })
  expect(deliveryAck(ID, 'pending', true, NOW)).toEqual({ id: ID, status: 'queued', reason: null, at: NOW })
  expect(deliveryAck(ID, 'entered', true, NOW).status).toBe('queued')
  expect(deliveryAck(ID, 'dropped', false, NOW)).toEqual({ id: ID, status: 'failed', reason: 'dropped', at: NOW })
  expect(deliveryAck(ID, 'threw', true, NOW).status).toBe('failed')
  expect(refusalAck(ID, 'withdrawn', NOW)).toEqual({ id: ID, status: 'refused', reason: 'withdrawn', at: NOW })
  expect(JSON.stringify(deliveryAck(ID, 'entered', false, NOW))).not.toContain('go ahead')
  expect([isDelivered('sent'), isDelivered('queued'), isDelivered('refused'), isDelivered('failed'), isDelivered(undefined)]).toEqual([true, true, false, false, false])
})

test('a withdrawal is decided by file state: unclaimed is withdrawn, claimed waits for the acknowledgement, none in time is unknown', () => {
  expect(withdrawVerdict('pending', null, false)).toBe('withdrawn')
  expect(withdrawVerdict('done', null, false)).toBe('wait')
  expect(withdrawVerdict('done', null, true)).toBe('unknown')
  expect(withdrawVerdict('missing', null, true)).toBe('unknown')
  expect(withdrawVerdict('done', { status: 'sent' }, false)).toBe('delivered')
  expect(withdrawVerdict('done', { status: 'queued' }, true)).toBe('delivered')
  expect(withdrawVerdict('done', { status: 'refused' }, false)).toBe('withdrawn')
  expect(withdrawVerdict('pending', { status: 'sent' }, false)).toBe('delivered')
  expect(withdrawOutcome({ status: 'withdrawn' }, null)).toBe('withdrawn')
  expect(withdrawOutcome({ status: 'queued' }, null)).toBe('delivered')
  expect(withdrawOutcome({ status: 'unknown' }, null)).toBe('unknown')
  expect(withdrawOutcome(null, 404)).toBe('unknown')
  expect(withdrawOutcome(null, 0)).toBe('unknown')
  expect(withdrawOutcome({ status: 'withdrawn' }, 500)).toBe('unknown')
})

test('inbox statistics count each request once, without text, and are re-cleaned when read back', () => {
  const once = countInbox(null, { kind: 'delivered' }, NOW)
  const twice = countInbox(once, { kind: 'refused', reason: 'stale' }, NOW + 1)
  expect(twice).toEqual({ delivered: 1, lastDeliveredAt: NOW, refused: 1, lastRefusal: 'stale', lastRefusedAt: NOW + 1 })
  expect(countInbox(once, { kind: 'unqueued' }, NOW + 2)).toEqual({ delivered: 0, lastDeliveredAt: NOW, refused: 1, lastRefusal: 'dropped', lastRefusedAt: NOW + 2 })
  expect(inboxSummary(twice, NOW + 120_000)).toBe('1 delivered (last 2m ago) · 1 refused (last: it expired after a minute, 2m ago)')
  expect(inboxSummary(null, NOW)).toBe('none yet')
  expect([knownReason('replay'), knownReason('the secret text'), knownReason(3)]).toEqual(['replay', null, null])
  expect(cleanInboxStats({ delivered: -3, refused: 'x', lastRefusal: 'the secret text', lastDeliveredAt: NOW })).toEqual({
    delivered: 0,
    lastDeliveredAt: NOW,
    refused: 0,
    lastRefusal: null,
    lastRefusedAt: null,
  })
  expect(cleanInboxStats('nope')).toBeNull()
  const record = cleanRecord({ ...pub(), inbox: { ...twice, lastRefusal: 'leaked words' } } as never)
  expect(record.inbox).toEqual({ ...twice, lastRefusal: null })
  expect(cleanRecord(pub()).inbox).toBeNull()
})

test('replies are the one route: as you to sessions on reply protocol 2; no message box for older sessions or with replies off, and the line says why', () => {
  const newer = session('local_a', { publisher: { modVersion: '1.16.0', engineVersion: null, heartbeatAt: NOW, endedAt: null, replyProtocol: 2 } as never })
  const older = session('local_b', { publisher: { modVersion: '1.15.2', engineVersion: null, heartbeatAt: NOW, endedAt: null } })
  expect([sendMode(newer, true), sendMode(older, true), sendMode(session('local_c'), true), sendMode(newer, false), sendMode(older, false)]).toEqual(['reply', 'older', 'older', 'off', 'older'])
  expect(sendBlock('reply')).toBe(null)
  expect(sendBlock('off')).toEqual({ short: 'Replies are off.', text: 'Replies as me is off, so Orbit can’t send to sessions. Turn it on in Settings (it applies to every Orbit window) to reply here.' })
  expect(sendBlock('older')).toEqual({ short: 'Can’t message this session from Orbit: open it in Claude.', text: 'This session doesn’t run Orbit 1.9 or later, so it can’t take replies from here. Open it in Claude to message it.' })
  expect(REPLY_OLDER_TEXT).toBe('Not sent: this session’s Orbit is too old for replies. Open it in Claude.')
  expect(sendAfterAck('local_a', { status: 'sent', reason: null }, 'hi')).toEqual({ key: 'local_a', draft: '', status: 'sent', message: '' })
  expect(sendAfterAck('local_a', { status: 'queued', reason: null }, 'hi').message).toBe('Queued as you: sends when the session is idle.')
  expect(sendAfterAck('local_a', { status: 'refused', reason: 'stale' }, 'hi')).toEqual({ key: 'local_a', draft: 'hi', status: 'failed', message: 'Not sent: it expired after a minute.' })
  expect(sendAfterAck('local_a', { status: 'refused', reason: 'replay' }, 'hi').message).toBe('Not sent: it was already handled.')
  expect(sendAfterAck('local_a', { status: 'failed', reason: 'bogus' as never }, 'hi').message).toBe('Not sent: the session didn’t accept it.')
  expect(replyDeadline(NOW)).toBe(NOW + REPLY_TTL_MS + 10_000)
})

test('the read-only chat line says why: asleep desktop sessions say how to wake them, ended and id-less ones say ended, older snapshots read as ended', () => {
  expect(readOnlyText({ messageBlock: 'asleep' })).toBe('This session is asleep: Claude desktop stopped it while idle. Send it a message in Claude desktop to wake it, then reply here.')
  expect(readOnlyText({ messageBlock: 'ended' })).toBe('Read only: this session has ended, so it can’t take messages.')
  expect(readOnlyText({ messageBlock: 'no-id' })).toContain('no Claude Code id')
  expect(readOnlyText({})).toBe(readOnlyText({ messageBlock: 'ended' }))
  expect(readOnlyText({ messageBlock: null })).toBe(readOnlyText({ messageBlock: 'ended' }))
})

test('2.1.9: a reply that settles while its session is not open still replaces its "Waiting for the session…" box; another session\'s send stays', () => {
  const waiting: Send = { key: 'local_a', draft: 'hi', status: 'sending', message: 'Waiting for the session…' }
  const sent: Send = { key: 'local_a', draft: 'hi', status: 'sent', message: '', settledAt: 5 }
  expect(sendUpdate(waiting, 'local_a', sent, false)).toEqual(sent)
  expect(sendUpdate(waiting, 'local_a', null, false)).toBeNull()
  expect(sendUpdate(waiting, 'local_a', sent, true)).toEqual(sent)
  const other: Send = { key: 'local_b', draft: 'yo', status: 'sending', message: 'Waiting for the session…' }
  expect(sendUpdate(other, 'local_a', sent, false)).toBe(other)
  expect(sendUpdate(other, 'local_a', sent, true)).toEqual(sent)
  expect(sendUpdate(null, 'local_a', sent, false)).toBeNull()
})
