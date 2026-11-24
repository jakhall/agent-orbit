import assert from 'node:assert/strict'
import test from 'node:test'

import { createReplyQueue } from '../../companion/lib/replies.mjs'

const NOW = 1_800_000_000_000

test('replies and launch first prompts reach a mod only while replies are armed (D-6, E-02)', () => {
  let armed = false
  const q = createReplyQueue({ now: () => NOW, isArmed: () => armed })
  const reply = q.queue({ cli: 'cli-1', text: 'hello' })
  const first = q.queue({ cli: 'cli-1', text: 'Fix the bug', firstPrompt: true })
  assert.deepEqual(q.pendingFor('cli-1'), { armed: false, replies: [] })
  armed = true
  assert.deepEqual(q.pendingFor('cli-1').replies.map(r => r.id).sort(), [reply.id, first.id].sort())
  assert.deepEqual(q.pendingFor('cli-2').replies, [], 'a mod sees only its own')
  assert.deepEqual(q.pendingFor('cli-1').replies.find(r => r.id === first.id)?.firstPrompt, true)
})

test('claim once, then acknowledge; the page reads the answer once (E-02)', () => {
  const q = createReplyQueue({ now: () => NOW, isArmed: () => true })
  const { id } = q.queue({ cli: 'cli-1', text: 'hello' })
  assert.deepEqual(q.claim(id, 'cli-2'), { ok: false, reason: 'unknown' }, 'another session cannot claim it')
  assert.deepEqual(q.claim(id, 'cli-1'), { ok: true })
  assert.deepEqual(q.claim(id, 'cli-1'), { ok: false, reason: 'replay' })
  assert.deepEqual(q.pendingFor('cli-1').replies, [], 'a claimed reply is not handed out again')
  assert.deepEqual(q.result(id), { status: 'pending' })
  assert.equal(q.ack(id, 'cli-1', { status: 'made-up' }), false)
  assert.equal(q.ack(id, 'cli-1', { status: 'sent', reason: null, at: NOW }), true)
  assert.deepEqual(q.result(id), { status: 'sent', reason: null, at: NOW })
  assert.equal(q.result(id), null)
})

test('withdrawing: before the claim it is withdrawn at once; after it, the acknowledgement decides (E-02)', () => {
  const q = createReplyQueue({ now: () => NOW, isArmed: () => true })
  const early = q.queue({ cli: 'cli-1', text: 'a' })
  assert.equal(q.withdraw(early.id, false).verdict, 'withdrawn')
  assert.deepEqual(q.claim(early.id, 'cli-1'), { ok: false, reason: 'unknown' })
  const late = q.queue({ cli: 'cli-1', text: 'b' })
  q.claim(late.id, 'cli-1')
  assert.equal(q.withdraw(late.id, false).verdict, 'wait')
  q.ack(late.id, 'cli-1', { status: 'sent', at: NOW })
  assert.deepEqual(q.withdraw(late.id, false), { verdict: 'delivered', ack: { status: 'sent', reason: null, at: NOW } })
  const lost = q.queue({ cli: 'cli-1', text: 'c' })
  q.claim(lost.id, 'cli-1')
  assert.equal(q.withdraw(lost.id, true).verdict, 'unknown')
})

test('a reply older than 60 s is not handed out and is reported once as expired', () => {
  let at = NOW
  const q = createReplyQueue({ now: () => at, isArmed: () => true })
  const { id } = q.queue({ cli: 'cli-1', text: 'a' })
  at = NOW + 61_000
  assert.deepEqual(q.pendingFor('cli-1').replies, [])
  assert.deepEqual(q.expired(at), [id])
  assert.deepEqual(q.expired(at), [])
})

test('a mod holds a reply for its running turn: still withdrawable, wait can change, deliverable for 30 minutes', () => {
  let at = NOW
  const q = createReplyQueue({ now: () => at, isArmed: () => true })
  const { id } = q.queue({ cli: 'cli-1', text: 'a' })
  assert.deepEqual(q.hold(id, 'cli-2'), { ok: false, reason: 'unknown' })
  assert.deepEqual(q.hold(id, 'cli-1'), { ok: true })
  assert.deepEqual(q.result(id), { status: 'held', wait: false })
  assert.equal(q.setWait(id, true), true)
  assert.deepEqual(q.result(id), { status: 'held', wait: true })
  at = NOW + 20 * 60_000
  assert.deepEqual(q.pendingFor('cli-1').replies, [{ schema: 1, id, to: 'cli-1', text: 'a', createdAt: NOW, held: true, wait: true }])
  assert.deepEqual(q.expired(at), [])
  at = NOW + 31 * 60_000
  assert.deepEqual(q.pendingFor('cli-1').replies, [])
  assert.deepEqual(q.expired(at), [id])
})

test('holding and waiting are refused once a reply is claimed or withdrawn; a held reply withdraws at once', () => {
  const q = createReplyQueue({ now: () => NOW, isArmed: () => true })
  const claimed = q.queue({ cli: 'cli-1', text: 'a' })
  q.hold(claimed.id, 'cli-1')
  q.claim(claimed.id, 'cli-1')
  assert.deepEqual(q.hold(claimed.id, 'cli-1'), { ok: false, reason: 'replay' })
  assert.equal(q.setWait(claimed.id, true), false)
  assert.deepEqual(q.result(claimed.id), { status: 'pending' })
  const held = q.queue({ cli: 'cli-1', text: 'b' })
  q.hold(held.id, 'cli-1')
  assert.equal(q.withdraw(held.id, false).verdict, 'withdrawn')
  assert.deepEqual(q.hold(held.id, 'cli-1'), { ok: false, reason: 'unknown' })
  assert.equal(q.setWait(held.id, true), false)
})

test('an unheld reply cannot be held after its minute', () => {
  let at = NOW
  const q = createReplyQueue({ now: () => at, isArmed: () => true })
  const { id } = q.queue({ cli: 'cli-1', text: 'a' })
  at = NOW + 61_000
  assert.deepEqual(q.hold(id, 'cli-1'), { ok: false, reason: 'expired' })
})

test('a slash command reply always waits for the turn to end: wait cannot be turned off, and the page hears it is a command', () => {
  const q = createReplyQueue({ now: () => NOW, isArmed: () => true })
  const { id } = q.queue({ cli: 'cli-1', text: '/compact', command: true })
  assert.deepEqual(q.hold(id, 'cli-1'), { ok: true })
  assert.equal(q.setWait(id, false), false)
  assert.deepEqual(q.result(id), { status: 'held', wait: true, command: true })
})

test('a message for a sub-agent carries its agentId, is never held and cannot be switched to wait', () => {
  const q = createReplyQueue({ now: () => NOW, isArmed: () => true })
  const { id } = q.queue({ cli: 'cli-1', text: 'focus on the tests', agentId: 'agent-a1' })
  assert.deepEqual(q.pendingFor('cli-1').replies, [{ schema: 1, id, to: 'cli-1', text: 'focus on the tests', createdAt: NOW, agentId: 'agent-a1' }])
  assert.deepEqual(q.hold(id, 'cli-1'), { ok: false, reason: 'replay' })
  assert.equal(q.setWait(id, true), false)
  assert.deepEqual(q.claim(id, 'cli-1'), { ok: true })
})
