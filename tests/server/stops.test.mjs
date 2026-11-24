import assert from 'node:assert/strict'
import test from 'node:test'

import { createStopQueue, STOP_TTL_MS } from '../../companion/lib/stops.mjs'

const NOW = 1_800_000_000_000

test('stop: one open request per session, claimed once by that session, read once by the page', () => {
  let at = NOW
  const q = createStopQueue({ now: () => at })
  const first = q.request('cli-1')
  assert.deepEqual(q.request('cli-1'), first, 'a second click reuses the open request')
  assert.deepEqual(q.pendingFor('cli-1'), [{ id: first.id, createdAt: NOW }])
  assert.deepEqual(q.pendingFor('cli-2'), [], 'a mod sees only its own')
  assert.deepEqual(q.claim(first.id, 'cli-2'), { ok: false, reason: 'unknown' })
  assert.equal(q.ack(first.id, 'cli-1', 'stopped'), false, 'no outcome before a claim')
  assert.deepEqual(q.claim(first.id, 'cli-1'), { ok: true })
  assert.deepEqual(q.claim(first.id, 'cli-1'), { ok: false, reason: 'replay' })
  assert.deepEqual(q.pendingFor('cli-1'), [])
  assert.deepEqual(q.result(first.id), { status: 'pending' })
  assert.equal(q.ack(first.id, 'cli-1', 'made-up'), false)
  assert.equal(q.ack(first.id, 'cli-1', 'stopped'), true)
  assert.equal(q.ack(first.id, 'cli-1', 'idle'), false, 'one outcome only')
  assert.deepEqual(q.result(first.id), { status: 'stopped' })
  assert.equal(q.result(first.id), null)
  assert.notEqual(q.request('cli-1').id, first.id, 'a later click is a new request')
})

test('stop: an unclaimed request expires, is not handed out, and is logged once', () => {
  let at = NOW
  const q = createStopQueue({ now: () => at })
  const { id } = q.request('cli-1')
  at += STOP_TTL_MS + 1
  assert.deepEqual(q.pendingFor('cli-1'), [])
  assert.deepEqual(q.claim(id, 'cli-1'), { ok: false, reason: 'expired' })
  assert.deepEqual(q.expired(at), [id])
  assert.deepEqual(q.expired(at), [])
  assert.deepEqual(q.result(id), { status: 'expired' })
  assert.equal(q.result(id), null)
})

test('stop: a sub-agent stop is its own request, handed out with its agentId', () => {
  const q = createStopQueue({ now: () => NOW })
  const turn = q.request('cli-1')
  const agent = q.request('cli-1', 'agent-a1')
  assert.notEqual(agent.id, turn.id, 'stopping a sub-agent is not stopping the turn')
  assert.deepEqual(q.request('cli-1', 'agent-a1'), agent, 'a second click on the same sub-agent reuses it')
  assert.notEqual(q.request('cli-1', 'agent-b2').id, agent.id)
  assert.deepEqual(q.pendingFor('cli-1').find(s => s.id === agent.id), { id: agent.id, createdAt: NOW, agentId: 'agent-a1' })
  assert.equal('agentId' in q.pendingFor('cli-1').find(s => s.id === turn.id), false)
})
