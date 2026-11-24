import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'

import { approvalView, hashText } from '../../shared/approvals.js'
import { createRequestStore, HELD_LEASE_MS, HELD_MAX_MS } from '../../companion/lib/requests.mjs'

const NOW = 1_800_000_000_000
const toolInput = { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] }
const inputHash = createHash('sha256').update(hashText('AskUserQuestion', toolInput)).digest('hex')
const hold = (store, patch = {}) => store.hold({ cliSessionId: 'cli-1', toolInput, agentId: null, cwd: 'C:\\repo', ...patch })

test('2.1.6: a held question is engaged without a window, shown as held, and answered into an AskUserQuestion result', async () => {
  const store = createRequestStore({ now: () => NOW, isEngaged: () => false, isHeldEngaged: () => true })
  const held = hold(store)
  assert.equal(held.body.engaged, true)
  assert.match(held.body.nonce, /^[0-9a-f-]{36}$/)
  const [shown] = store.list()
  assert.equal(shown.id, held.body.id)
  assert.equal(shown.held, true)
  assert.equal(shown.expiresAt, NOW + HELD_MAX_MS)
  const waiting = store.wait(held.body.id, held.body.nonce, 5_000)
  assert.equal(store.answer(held.body.id, { behavior: 'answer', inputHash, answers: { 'Which?': { labels: ['B'] } }, notes: { 'Which?': 'why B' } }).status, 200)
  const got = await waiting
  assert.equal(got.body.status, 'answered')
  assert.deepEqual(got.body.result, { ...toolInput, answers: { 'Which?': 'B' }, annotations: { 'Which?': { notes: 'why B' } } })
  assert.equal((await store.wait(held.body.id, held.body.nonce, 0)).status, 410)
})

test('2.1.6: an ask from Orbit gives no result, so the mod keeps waiting on Claude', async () => {
  const store = createRequestStore({ now: () => NOW, isEngaged: () => false, isHeldEngaged: () => true })
  const held = hold(store)
  store.answer(held.body.id, { behavior: 'ask', inputHash })
  const got = await store.wait(held.body.id, held.body.nonce, 0)
  assert.equal(got.body.result, null)
})

test('2.1.6: not engaged (questions not armed or session unknown) holds nothing; a broken question is refused', () => {
  const store = createRequestStore({ now: () => NOW, isEngaged: () => true, isHeldEngaged: () => false })
  assert.deepEqual(hold(store).body, { engaged: false })
  assert.deepEqual(store.list(), [])
  assert.equal(hold(store, { toolInput: { questions: 'nope' } }).status, 400)
})

test('2.1.6: answered in Claude ends the held copy; only the nonce holder can end it', () => {
  const lines = []
  const store = createRequestStore({ now: () => NOW, isEngaged: () => false, isHeldEngaged: () => true, log: line => lines.push(line) })
  const held = hold(store)
  assert.equal(store.end(held.body.id, randomUUID(), 'answered in Claude').status, 403)
  assert.equal(store.end(held.body.id, held.body.nonce, 'answered in Claude').status, 200)
  assert.deepEqual(store.list(), [])
  assert.deepEqual(lines, [`question ${held.body.id} held`, `question ${held.body.id} answered in Claude`])
})

test('2.1.6: a held question outlives its windows but not its mod: the lease runs out without polls', async () => {
  let at = NOW
  const lines = []
  const store = createRequestStore({ now: () => at, isEngaged: () => false, isHeldEngaged: () => true, log: line => lines.push(line) })
  const held = hold(store)
  at += HELD_LEASE_MS - 1
  store.sweep({ isWindowGone: true })
  assert.equal(store.list().length, 1, 'no window left does not end a held question')
  await store.wait(held.body.id, held.body.nonce, 0)
  at += HELD_LEASE_MS - 1
  store.sweep({ isWindowGone: true })
  assert.equal(store.list().length, 1, 'a poll renews the lease')
  at += HELD_LEASE_MS
  store.sweep({ isWindowGone: false })
  assert.deepEqual(store.list(), [])
  assert.equal(lines.at(-1), `question ${held.body.id} mod-gone`)
})

test('2.1.6: while a question is held, the PermissionRequest hook copy of it only marks the wait (no second card)', () => {
  const store = createRequestStore({ now: () => NOW, isEngaged: () => true, isHeldEngaged: () => true, isHookAlive: () => true })
  hold(store)
  const hooked = { schema: 1, id: randomUUID(), createdAt: NOW, expiresAt: NOW + 60_000, cliSessionId: 'cli-1', cwd: 'C:\\repo', toolName: 'AskUserQuestion', toolInput, truncated: false, inputHash, permissionMode: 'default', agentId: null, hookPid: 1, kind: 'question' }
  assert.deepEqual(store.register({ request: hooked, nonce: randomUUID() }).body, { engaged: false })
  assert.equal(store.list().length, 1)
  assert.equal(store.markers().get('cli-1')?.[0]?.kind, 'question')
})

test('2.1.6: approvalView passes held only for a held question', () => {
  const store = createRequestStore({ now: () => NOW, isEngaged: () => false, isHeldEngaged: () => true })
  hold(store)
  assert.equal(store.list()[0].held, true)
  assert.equal(Object.hasOwn(approvalView({ ...store.list()[0], held: false, toolInput }), 'held'), false)
})

test('2.1.6: a message dismisses a held question: the wait gives the message, not a result', async () => {
  const lines = []
  const store = createRequestStore({ now: () => NOW, isEngaged: () => false, isHeldEngaged: () => true, log: line => lines.push(line) })
  const held = hold(store)
  const waiting = store.wait(held.body.id, held.body.nonce, 5_000)
  assert.equal(store.answer(held.body.id, { behavior: 'dismiss', inputHash, message: '  Skip that, do X instead.\nThanks  ' }).status, 200)
  const got = await waiting
  assert.equal(got.body.status, 'dismissed')
  assert.equal(got.body.message, 'Skip that, do X instead.\nThanks')
  assert.equal(Object.hasOwn(got.body, 'result'), false)
  assert.equal(lines.at(-1), `question ${held.body.id} dismissed`)
})

test('2.1.6: dismiss needs a held question and a plain message of 1 to 2,000 characters', () => {
  const store = createRequestStore({ now: () => NOW, isEngaged: () => false, isHeldEngaged: () => true })
  const held = hold(store)
  for (const message of ['', '   ', 'x'.repeat(2_001), 'hi\u202Ethere', 42]) {
    assert.equal(store.answer(held.body.id, { behavior: 'dismiss', inputHash, message }).status, 400, JSON.stringify(message))
  }
  const hooked = createRequestStore({ now: () => NOW, isEngaged: () => true, isHookAlive: () => true })
  const request = { schema: 1, id: randomUUID(), createdAt: NOW, expiresAt: NOW + 60_000, cliSessionId: 'cli-2', cwd: 'C:\repo', toolName: 'AskUserQuestion', toolInput, truncated: false, inputHash, permissionMode: 'default', agentId: null, hookPid: 1, kind: 'question' }
  assert.equal(hooked.register({ request, nonce: randomUUID() }).body.engaged, true)
  const refused = hooked.answer(request.id, { behavior: 'dismiss', inputHash, message: 'hello' })
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /Only a question open in Orbit and Claude at once/)
})
