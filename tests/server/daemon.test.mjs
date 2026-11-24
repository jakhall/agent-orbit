import assert from 'node:assert/strict'
import test from 'node:test'

import { IDLE_EXIT_MS, isActingRoute, isWindowAway, launchDecision, shouldCheckPrs, shouldIdleExit, WINDOW_GRACE_MS } from '../../companion/lib/daemon.mjs'
import { isOlderVersion } from '../../shared/version.js'

test('versions compare as numbers; a missing or malformed version counts as older', () => {
  assert.equal(isOlderVersion('1.15.2', '1.16.0'), true)
  assert.equal(isOlderVersion('1.16.0', '1.15.2'), false)
  assert.equal(isOlderVersion('1.16.0', '1.16.0'), false)
  assert.equal(isOlderVersion('1.9.0', '1.10.0'), true)
  assert.equal(isOlderVersion(undefined, '1.0.0'), true)
})

test('launch: start when none runs, replace only an older server, never a newer one; a window only when asked (daemon)', () => {
  assert.deepEqual(launchDecision(null, '1.16.0', true), { action: 'start', openWindow: true })
  assert.deepEqual(launchDecision(null, '1.16.0', false), { action: 'start', openWindow: false })
  assert.deepEqual(launchDecision({ version: '1.15.2' }, '1.16.0', false), { action: 'replace', openWindow: false })
  assert.deepEqual(launchDecision({ version: undefined }, '1.16.0', true), { action: 'replace', openWindow: true })
  assert.deepEqual(launchDecision({ version: '1.16.0' }, '1.16.0', true), { action: 'reuse', openWindow: true })
  assert.deepEqual(launchDecision({ version: '1.16.0' }, '1.16.0', false), { action: 'reuse', openWindow: false })
  assert.deepEqual(launchDecision({ version: '1.17.0' }, '1.16.0', true), { action: 'reuse', openWindow: true }, 'a newer server is never replaced')
  assert.deepEqual(launchDecision({ version: '1.15.2', clients: 1 }, '1.16.0', false), { action: 'replace', openWindow: true }, 'replacing a server with a window open opens a new window')
})

test('idle exit: only after 30 minutes with no window and no session record change (daemon)', () => {
  const now = 10 * IDLE_EXIT_MS
  const quiet = { now, clients: 0, lastClientAt: now - IDLE_EXIT_MS - 1, lastRecordChangeAt: now - IDLE_EXIT_MS - 1, startedAt: 0 }
  assert.equal(shouldIdleExit(quiet), true)
  assert.equal(shouldIdleExit({ ...quiet, clients: 1 }), false)
  assert.equal(shouldIdleExit({ ...quiet, lastClientAt: now - 60_000 }), false)
  assert.equal(shouldIdleExit({ ...quiet, lastRecordChangeAt: now - 60_000 }), false)
  assert.equal(shouldIdleExit({ ...quiet, startedAt: now - 60_000, lastClientAt: 0, lastRecordChangeAt: 0 }), false, 'a fresh server waits the full period')
})

test('acting routes need an open window; read routes never do (no-window 409, daemon)', () => {
  const id = '0a1b2c3d-0000-4000-8000-000000000001'
  for (const route of ['/api/reply', `/api/reply/${id}/withdraw`, `/api/reply/${id}/wait`, '/api/launch', '/api/open', '/api/new', `/api/approvals/${id}`, '/api/approvals/enabled', '/api/clear', '/api/arm', '/api/stop']) assert.equal(isActingRoute('POST', route), true, route)
  for (const route of ['/api/state', '/api/health', '/api/approvals', `/api/reply/${id}`, '/api/launch/options', `/api/launch/${id}`]) assert.equal(isActingRoute('GET', route), false, route)
  for (const route of ['/api/prefs', '/api/attention', '/api/stats', '/api/window', '/api/shutdown']) assert.equal(isActingRoute('POST', route), false, route)
})

test('a window counts as present while its stream is open and for a short reconnect grace after it closes (daemon)', () => {
  const now = 1_000_000
  assert.equal(isWindowAway({ clients: 1, lastClientAt: 0, now }), false)
  assert.equal(isWindowAway({ clients: 0, lastClientAt: 0, now }), true, 'never connected')
  assert.equal(isWindowAway({ clients: 0, lastClientAt: now - 3_000, now }), false, 'a page reconnecting after a blip')
  assert.equal(isWindowAway({ clients: 0, lastClientAt: now - WINDOW_GRACE_MS - 1, now }), true)
})

test('after C9: PR checks run for an attentive window that shows PRs, as before (E-114), or with "PR problems need you" on, with no window at all', () => {
  const quiet = { windows: 0, attentiveAgoMs: Infinity, isShown: false, isNeedOn: false }
  assert.equal(shouldCheckPrs(quiet), false)
  assert.equal(shouldCheckPrs({ ...quiet, windows: 1, attentiveAgoMs: 5_000 }), false, 'a window in use that shows no PRs runs no gh')
  assert.equal(shouldCheckPrs({ ...quiet, windows: 1, attentiveAgoMs: 5_000, isShown: true }), true)
  assert.equal(shouldCheckPrs({ ...quiet, windows: 1, attentiveAgoMs: 120_000, isShown: true }), false, 'not attentive in the last minute')
  assert.equal(shouldCheckPrs({ ...quiet, isNeedOn: true }), true, 'the opt-in needs no window')
})
