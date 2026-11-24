import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeDesktop } from '../../shared/aggregate/desktop.js'
import { lifecycleOf, publisherActivityAt } from '../../shared/aggregate/infer.js'
import { normalizeSnapshot } from '../../shared/filters.js'
import { layoutGraph } from '../../shared/layout.js'
import { snapshotOf } from '../../tools/bench-shared.mjs'

const NOW = 1_800_000_000_000
const LOCAL = 'local_0a1b2c3d-0000-4000-8000-000000000001'
const STALE = 10 * 60_000

const fresh = (patch = {}) => ({ sessionId: LOCAL, cliSessionId: 'cli-1', createdAt: NOW - 3_000, lastTurnEdgeAt: NOW - 3_000, latestUserFrameAt: NOW - 1_000, ...patch })

test('a new session\'s start-up waiting-input marker, written before its first prompt, is not a question', () => {
  const d = normalizeDesktop(fresh(), NOW, new Map([[LOCAL, NOW - 3_000]]))
  assert.equal(d?.isWaitingInput, false)
  assert.equal(lifecycleOf({ desktop: d, publisher: null, now: NOW, staleMs: STALE }).lifecycle, 'running')
})

test('a brand-new session whose marker lands before the desktop records the prompt is starting, not "needs you", until its mod takes over', () => {
  const sent = { createdAt: NOW - 75_000, lastTurnEdgeAt: NOW - 300, latestUserFrameAt: undefined, completedTurns: undefined }
  const d = normalizeDesktop(fresh(sent), NOW, new Map([[LOCAL, NOW - 200]]))
  assert.equal(d?.isWaitingInput, false)
  const before = lifecycleOf({ desktop: d, publisher: null, now: NOW, staleMs: STALE })
  assert.equal(before.lifecycle, 'running')
  assert.equal(before.attention, null)
  assert.equal(lifecycleOf({ desktop: d, publisher: pub(), now: NOW, staleMs: STALE }).lifecycle, 'running')
  assert.equal(normalizeDesktop(fresh(sent), NOW, new Map())?.isMidTurn, false)
  assert.equal(normalizeDesktop(fresh({ ...sent, completedTurns: 2 }), NOW, new Map([[LOCAL, NOW - 200]]))?.isWaitingInput, true)
})

test('a waiting-input marker written well after the typed prompt is a question; one with no time or no open turn still counts', () => {
  assert.equal(normalizeDesktop(fresh(), NOW, new Map([[LOCAL, NOW - 1_000 + 30_000]]))?.isWaitingInput, true)
  assert.equal(normalizeDesktop(fresh(), NOW, new Map([[LOCAL, null]]))?.isWaitingInput, true)
  assert.equal(normalizeDesktop(fresh(), NOW, new Set([LOCAL]))?.isWaitingInput, true)
  assert.equal(normalizeDesktop(fresh({ latestUserFrameAt: NOW - 10_000 }), NOW, new Map([[LOCAL, NOW - 20_000]]))?.isWaitingInput, true)
})

const pub = (patch = {}) => ({
  schema: 1,
  cliSessionId: 'cli-1',
  modVersion: '2.2.9',
  engineVersion: null,
  entrypoint: 'claude-desktop',
  cwd: 'C:\\repo',
  repoRoot: null,
  repoRemote: null,
  repoName: null,
  model: null,
  startedAt: NOW - 500,
  updatedAt: NOW - 500,
  heartbeatAt: NOW - 500,
  endedAt: null,
  endReason: null,
  turn: { isRunning: false, startedAt: null, endedAt: null, lastReason: null },
  waiting: null,
  context: null,
  tools: [],
  timeline: [],
  agents: [],
  ...patch,
})

test('a woken session whose mod has not yet seen the typed prompt is running, not the last turn\'s "needs you"', () => {
  const d = normalizeDesktop(fresh({ completedTurns: 3, postTurnSummary: { status_category: 'blocked', needs_action: 'Run the deploy' } }), NOW, new Map())
  const woken = lifecycleOf({ desktop: d, publisher: pub(), now: NOW, staleMs: STALE })
  assert.equal(woken.lifecycle, 'running')
  assert.equal(woken.attention, null)
  const seen = pub({ turn: { isRunning: false, startedAt: NOW - 900, endedAt: NOW - 200, lastReason: 'end_turn' } })
  assert.equal(lifecycleOf({ desktop: d, publisher: seen, now: NOW, staleMs: STALE }).attention, 'needs-you')
})

test('idle heartbeats are not activity: a session idle for days drops out of time windows while its process lives', () => {
  const sixDays = NOW - 6 * 86_400_000
  const idle = pub({ startedAt: NOW - 40 * 60_000, updatedAt: NOW, heartbeatAt: NOW, turn: { isRunning: false, startedAt: sixDays, endedAt: sixDays + 60_000, lastReason: 'end_turn' } })
  assert.equal(publisherActivityAt(idle, true), sixDays + 60_000)
  assert.equal(publisherActivityAt(pub({ startedAt: NOW - 40 * 60_000 }), false), NOW - 40 * 60_000)
  assert.equal(publisherActivityAt(pub({ updatedAt: NOW, turn: { isRunning: true, startedAt: sixDays, endedAt: null, lastReason: null } }), true), NOW)
  assert.equal(publisherActivityAt(pub({ updatedAt: NOW, tools: [{ at: NOW - 5_000, tool: 'Bash', category: 'command', target: 'ls', isError: false, agentId: null }] }), true), NOW - 5_000)
})

test('dragged hubs stay exactly where they were dropped, even on top of each other; computed hubs keep clear of them', () => {
  const n = normalizeSnapshot(snapshotOf(120, 6, 3, NOW))
  const hubs = layoutGraph(n, {}).nodes.filter(x => x.kind === 'project')
  const [older, younger] = [hubs[0], hubs[1]]
  const graph = layoutGraph(n, { [older.id]: { dx: 1000, dy: 1000 }, [younger.id]: { dx: 1050, dy: 1020 } })
  const at = id => graph.nodes.find(x => x.id === id)
  const reach = hub => Math.max(0, ...graph.nodes.filter(x => x.kind === 'session' && x.parent === hub.id).map(x => Math.hypot(x.x - hub.x, x.y - hub.y)))
  const [a, b] = [at(older.id), at(younger.id)]
  assert.deepEqual([a.x, a.y], [1000, 1000])
  assert.deepEqual([b.x, b.y], [1050, 1020])
  for (const other of graph.nodes.filter(x => x.kind === 'project' && x.id !== a.id && x.id !== b.id)) {
    for (const hub of [a, b]) assert.ok(Math.hypot(other.x - hub.x, other.y - hub.y) >= reach(hub), `${other.id} was placed inside ${hub.id}`)
  }
})

test('a start-up marker written seconds after the prompt (slow start or wake) is not a question once the mod runs the turn; a later one is', () => {
  const typed = NOW - 20_000
  const late = new Map([[LOCAL, typed + 12_000]])
  const woken = fresh({ completedTurns: 4, lastTurnEdgeAt: NOW - 3_600_000, latestUserFrameAt: typed })
  const d = normalizeDesktop(woken, NOW, late)
  assert.equal(d?.isWaitingInput, true)
  const running = pub({ updatedAt: NOW - 300, heartbeatAt: NOW - 300, turn: { isRunning: true, startedAt: typed + 11_000, endedAt: null, lastReason: null } })
  const started = lifecycleOf({ desktop: d, publisher: running, now: NOW, staleMs: STALE })
  assert.equal(started.lifecycle, 'running')
  assert.equal(started.attention, null)
  const notYet = pub({ turn: { isRunning: false, startedAt: NOW - 3_700_000, endedAt: NOW - 3_600_000, lastReason: 'end_turn' } })
  assert.equal(lifecycleOf({ desktop: d, publisher: notYet, now: NOW, staleMs: STALE }).lifecycle, 'running')
  const asked = normalizeDesktop(woken, NOW, new Map([[LOCAL, typed + 40_000]]))
  assert.equal(lifecycleOf({ desktop: asked, publisher: running, now: NOW, staleMs: STALE }).attention, 'question')
  assert.equal(lifecycleOf({ desktop: d, publisher: null, now: NOW, staleMs: STALE }).attention, 'question')
})
