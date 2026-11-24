import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'

import { hashText, QUESTION_WAIT_MAX_MS } from '../../shared/approvals.js'
import { createRequestStore } from '../../companion/lib/requests.mjs'

const NOW = 1_800_000_000_000
const command = { command: 'rm x.txt' }
const hash = createHash('sha256').update(hashText('Bash', command)).digest('hex')
const request = (patch = {}) => ({ schema: 1, id: randomUUID(), createdAt: NOW, expiresAt: NOW + 60_000, cliSessionId: 'cli-1', cwd: 'C:\\repo', toolName: 'Bash', toolInput: command, truncated: false, inputHash: hash, permissionMode: 'default', agentId: null, hookPid: 1, ...patch })
const nonce = () => randomUUID()

test('not engaged: only a text-free wait marker is kept, nothing to answer (E-06 b)', () => {
  const store = createRequestStore({ now: () => NOW, isEngaged: () => false })
  const r = request()
  assert.deepEqual(store.register({ request: r, nonce: nonce() }).body, { engaged: false })
  assert.deepEqual(store.list(), [])
  assert.deepEqual(store.markers().get('cli-1'), [{ kind: 'permission', toolName: 'Bash', createdAt: NOW }])
  assert.equal(JSON.stringify([...store.markers()]).includes('rm x.txt'), false, 'no tool input in the marker')
  assert.deepEqual(store.register({ marker: { cliSessionId: 'cli-2', toolName: 'AskUserQuestion' }, nonce: nonce() }).body, { engaged: false })
  assert.equal(store.markers().get('cli-2')?.[0]?.kind, 'question')
})

test('engaged: the answer goes only to the hook holding the nonce, once (E-01)', async () => {
  const store = createRequestStore({ now: () => NOW, isEngaged: () => true })
  const r = request()
  const n = nonce()
  assert.deepEqual(store.register({ request: r, nonce: n }).body, { engaged: true, id: r.id })
  assert.equal(store.register({ request: r, nonce: n }).status, 409, 'an id is registered once')
  assert.equal((await store.wait(r.id, 'someone-else', 0)).status, 403)
  const waiting = store.wait(r.id, n, 5_000)
  assert.equal(store.answer(r.id, { behavior: 'allow', inputHash: hash }).status, 200)
  assert.equal(store.answer(r.id, { behavior: 'deny', inputHash: hash }).status, 409)
  const got = await waiting
  assert.equal(got.body.status, 'answered')
  assert.equal(got.body.answer.behavior, 'allow')
  assert.equal((await store.wait(r.id, n, 0)).status, 410, 'delivered once, then gone')
  assert.deepEqual(store.list(), [])
})

test('refused registrations: a broken request, a hash that does not match, an expired one, no nonce (E-01)', () => {
  const store = createRequestStore({ now: () => NOW, isEngaged: () => true })
  assert.equal(store.register({ request: { schema: 1 }, nonce: nonce() }).status, 400)
  assert.equal(store.register({ request: request({ toolInput: { command: 'git status' } }), nonce: nonce() }).status, 400)
  assert.equal(store.register({ request: request({ expiresAt: NOW - 1 }), nonce: nonce() }).status, 409)
  assert.equal(store.register({ request: request() }).status, 400)
})

test('a window going away ends open requests so Claude asks itself; expiry does too', () => {
  let at = NOW
  const lines = []
  const store = createRequestStore({ now: () => at, isEngaged: () => true, log: line => lines.push(line) })
  const a = request()
  const b = request({ expiresAt: NOW + 1_000 })
  store.register({ request: a, nonce: nonce() })
  store.register({ request: b, nonce: nonce() })
  at = NOW + 2_000
  store.sweep({ isWindowGone: false })
  assert.deepEqual(store.list().map(x => x.id), [a.id])
  store.sweep({ isWindowGone: true })
  assert.deepEqual(store.list(), [])
  assert.deepEqual(lines, [`approval ${b.id} expired`, `approval ${a.id} window-gone`])
})

test('a question someone is still typing an answer to is kept past 60 s, but never past the cap below the hook timeout (120 s installed); a tool approval is not (E-23)', async () => {
  let at = NOW
  const store = createRequestStore({ now: () => at, isEngaged: () => true })
  const questionInput = { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] }
  const qHash = createHash('sha256').update(hashText('AskUserQuestion', questionInput)).digest('hex')
  const q = request({ kind: 'question', toolName: 'AskUserQuestion', toolInput: questionInput, inputHash: qHash })
  const n = nonce()
  store.register({ request: q, nonce: n })
  assert.equal(QUESTION_WAIT_MAX_MS, 110_000)
  at = NOW + 30_000
  assert.equal(store.extend(q.id).status, 200)
  const waited = await store.wait(q.id, n, 0)
  assert.equal(waited.body.status, 'pending')
  assert.equal(waited.body.expiresAt, NOW + 90_000, 'the hook learns the new deadline')
  at = NOW + 80_000
  assert.equal(store.extend(q.id).body.expiresAt, NOW + QUESTION_WAIT_MAX_MS, 'capped')
  at = NOW + 100_000
  store.sweep({ isWindowGone: false })
  assert.deepEqual(store.list().map(x => x.id), [q.id], 'still open at 100 s')
  at = NOW + QUESTION_WAIT_MAX_MS + 1
  store.sweep({ isWindowGone: false })
  assert.deepEqual(store.list(), [], 'never past the cap')
  const tool = request({ createdAt: at, expiresAt: at + 60_000 })
  store.register({ request: tool, nonce: nonce() })
  assert.equal(store.extend(tool.id).status, 400)
})

test('registrations are clamped: created now, waiting at most the hook wait, a live hook process, and capped per session (review)', () => {
  const store = createRequestStore({ now: () => NOW, isEngaged: () => true, isHookAlive: pid => pid === 1 })
  assert.equal(store.register({ request: request({ createdAt: NOW - 60_000, expiresAt: NOW + 60_000 }), nonce: nonce() }).status, 400, 'created long ago')
  assert.equal(store.register({ request: request({ expiresAt: NOW + 3_600_000 }), nonce: nonce() }).status, 400, 'waiting an hour')
  assert.equal(store.register({ request: request({ hookPid: 2 }), nonce: nonce() }).status, 400, 'no live hook')
  for (let i = 0; i < 20; i += 1) assert.equal(store.register({ request: request(), nonce: nonce() }).status, 200)
  assert.equal(store.register({ request: request(), nonce: nonce() }).status, 429, 'at most 20 open per session')
})
