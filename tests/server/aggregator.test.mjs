import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAggregator } from '../../companion/lib/aggregator.mjs'
import { nodeHost } from '../../companion/lib/host.mjs'

const NOW = Date.now()

function record(id, patch = {}) {
  return {
    schema: 1,
    cliSessionId: id,
    modVersion: '1.15.2',
    engineVersion: '2.1.321',
    entrypoint: 'cli',
    cwd: 'C:\\repo\\app',
    repoRoot: 'C:\\repo\\app',
    repoRemote: null,
    repoName: null,
    model: 'claude-opus-5-5',
    startedAt: NOW - 600_000,
    updatedAt: NOW - 1_000,
    heartbeatAt: NOW - 1_000,
    endedAt: null,
    endReason: null,
    turn: { isRunning: false, startedAt: null, endedAt: null, lastReason: null },
    waiting: null,
    context: null,
    tools: [],
    timeline: [],
    agents: [],
    ...patch,
  }
}

const made = []
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function folder() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agg-'))
  made.push(data)
  const sessionsDir = path.join(data, 'sessions')
  fs.mkdirSync(sessionsDir)
  const paths = {
    sep: path.sep,
    data,
    sessionsDir,
    inboxDir: path.join(data, 'inbox'),
    snapshot: path.join(data, 'snapshot.json'),
    leader: path.join(data, 'leader.json'),
    prefs: path.join(data, 'prefs.json'),
    companion: path.join(data, 'companion.json'),
    desktopRoot: null,
    projectsDir: path.join(data, 'no-projects'),
    pluginRoot: data,
    system32: data,
  }
  const put = (id, patch) => fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(record(id, patch)))
  return { data, paths, put }
}

function aggregatorOn(paths, approvals = new Map(), clock = { at: NOW }) {
  const writes = []
  const aggregator = createAggregator({
    host: nodeHost(),
    paths,
    readPrefs: () => null,
    readApprovals: () => approvals,
    write: async text => {
      writes.push(JSON.parse(text))
    },
    serverVersion: 'test',
    now: () => clock.at,
  })
  return { aggregator, writes, clock }
}

test('the server aggregates watched records into schema 2, with a status per session and no graph (A3 tracer)', async () => {
  const { paths, put } = folder()
  put('run-1', { turn: { isRunning: true, startedAt: NOW - 60_000, endedAt: null, lastReason: null } })
  put('ask-1', { turn: { isRunning: true, startedAt: NOW - 60_000, endedAt: null, lastReason: null }, waiting: { kind: 'question', since: NOW - 20_000, tool: 'AskUserQuestion' } })
  const { aggregator, writes } = aggregatorOn(paths)
  await aggregator.run()
  const snapshot = writes.at(-1)
  assert.equal(snapshot.schema, 2)
  assert.equal(snapshot.generator, 'orbit-server')
  assert.equal(snapshot.seq, 1)
  assert.match(snapshot.bootId, /^[0-9a-f]{16}$/)
  assert.equal('graph' in snapshot, false)
  const byKey = new Map(snapshot.sessions.map(s => [s.key, s]))
  assert.deepEqual(byKey.get('cli:run-1').status.bucket, 'working')
  assert.deepEqual(byKey.get('cli:ask-1').status, { bucket: 'needs-you', reason: 'Asked you a question', since: NOW - 20_000, isObserved: true, isDone: false, snoozedUntil: null })
  assert.equal(aggregator.state.checkedAt, NOW)
})

test('an unchanged run confirms the snapshot (checkedAt moves) without writing; a change writes the next seq (A3)', async () => {
  const { paths, put } = folder()
  put('run-1', { turn: { isRunning: true, startedAt: NOW - 60_000, endedAt: null, lastReason: null } })
  const { aggregator, writes, clock } = aggregatorOn(paths)
  await aggregator.run()
  clock.at = NOW + 15_000
  await aggregator.run()
  assert.equal(writes.length, 1)
  assert.equal(aggregator.state.seq, 1)
  assert.equal(aggregator.state.checkedAt, NOW + 15_000)
  put('run-2', { updatedAt: NOW + 15_000, heartbeatAt: NOW + 15_000 })
  await aggregator.run()
  assert.equal(writes.length, 2)
  assert.equal(writes.at(-1).seq, 2)
})

test('a pending approval from the approvals folder makes the session Needs you, with no window open (A4)', async () => {
  const { paths, put } = folder()
  put('run-1', { turn: { isRunning: true, startedAt: NOW - 60_000, endedAt: null, lastReason: null } })
  const approvals = new Map([['run-1', [{ kind: 'permission', toolName: 'Bash', createdAt: NOW - 3_000 }]]])
  const { aggregator, writes } = aggregatorOn(paths, approvals)
  await aggregator.run()
  assert.deepEqual(writes.at(-1).sessions[0].status, { bucket: 'needs-you', reason: 'Approve Bash?', since: NOW - 3_000, isObserved: true, isDone: false, snoozedUntil: null })
})

test('desktop records give lineage, the last report and the last-focused time, and a finished turn not yet looked at is Review (A4)', async () => {
  const { data, paths } = folder()
  const org = path.join(data, 'desktop', 'acct', 'org')
  fs.mkdirSync(org, { recursive: true })
  const parentKey = 'local_0a1b2c3d-0000-4000-8000-0000000000aa'
  const childKey = 'local_0a1b2c3d-0000-4000-8000-0000000000bb'
  fs.writeFileSync(path.join(org, `${parentKey}.json`), JSON.stringify({ sessionId: parentKey, title: 'Parent', cwd: 'C:\repo\app', createdAt: NOW - 900_000, lastActivityAt: NOW - 600_000, lastTurnEdgeAt: NOW - 600_000, lastFocusedAt: NOW - 100_000 }))
  fs.writeFileSync(path.join(org, `${childKey}.json`), JSON.stringify({ sessionId: childKey, title: 'Child', cwd: 'C:\repo\app', createdAt: NOW - 500_000, lastActivityAt: NOW - 60_000, lastTurnEdgeAt: NOW - 60_000, lastFocusedAt: NOW - 300_000, spawnedFrom: { sessionId: parentKey, sideSession: true }, lastTurnReport: 'Fixed the login bug.', turnWrapUp: { description: 'Done', needsUser: 'Review the PR' } }))
  const { aggregator, writes } = aggregatorOn({ ...paths, desktopRoot: path.join(data, 'desktop') })
  await aggregator.run()
  const byKey = new Map(writes.at(-1).sessions.map(s => [s.key, s]))
  const child = byKey.get(childKey)
  assert.deepEqual(child.parent, { key: parentKey, kind: 'side-session' })
  assert.deepEqual(child.lastReport, { text: 'Fixed the login bug.', needsUser: true, ask: 'Review the PR', at: NOW - 60_000 })
  assert.equal(child.lastFocusedAt, NOW - 300_000)
  assert.equal(child.status.bucket, 'review')
  assert.equal(child.status.since, NOW - 60_000)
  assert.equal(byKey.get(parentKey).parent, null)
  assert.equal(byKey.get(parentKey).status.bucket, 'idle')
})

test('a watch event is carried to the change it caused, for event-to-paint latency; a run with no change drops it (G-34)', async () => {
  const { paths, put } = folder()
  put('run-1', { turn: { isRunning: true, startedAt: NOW - 60_000, endedAt: null, lastReason: null } })
  const { aggregator, clock } = aggregatorOn(paths)
  aggregator.noteEvent(NOW - 300)
  aggregator.noteEvent(NOW - 100)
  await aggregator.run()
  assert.equal(aggregator.state.lastEventAt, NOW - 100)
  assert.deepEqual({ seq: aggregator.state.lastChange.seq, eventAt: aggregator.state.lastChange.eventAt }, { seq: 1, eventAt: NOW - 300 }, 'the earliest event since the last run')
  aggregator.noteEvent(NOW + 1_000)
  clock.at = NOW + 2_000
  await aggregator.run()
  assert.equal(aggregator.state.lastChange.seq, 1, 'nothing changed')
  put('run-2', { updatedAt: NOW + 3_000, heartbeatAt: NOW + 3_000 })
  await aggregator.run()
  assert.deepEqual({ seq: aggregator.state.lastChange.seq, eventAt: aggregator.state.lastChange.eventAt }, { seq: 2, eventAt: null }, 'a timer-found change has no event behind it')
  assert.equal(typeof aggregator.state.lastChange.at, 'number')
})

test('PR problems need you: on, a quiet session linking a failing PR needs you from when the problem was first seen; off, nothing changes (after C9)', async () => {
  const { paths, data } = folder()
  const org = path.join(data, 'desktop', 'acct', 'org')
  fs.mkdirSync(org, { recursive: true })
  const key = 'local_0a1b2c3d-0000-4000-8000-0000000000e1'
  const url = 'https://github.com/acme/app/pull/12'
  fs.writeFileSync(path.join(org, `${key}.json`), JSON.stringify({ sessionId: key, title: 'With a PR', cwd: data, lastActivityAt: NOW - 60_000, prs: [{ url, prNumber: 12, repo: 'acme/app', branch: null, state: 'OPEN' }] }))
  const statuses = { [url]: { state: 'open', checks: 'failing', failing: ['build'], review: null, checkedAt: NOW - 5_000, since: NOW - 120_000 } }
  let prefs = { settings: { prProblemsNeedYou: false } }
  let asked = 0
  const writes = []
  const aggregator = createAggregator({
    host: nodeHost(),
    paths: { ...paths, desktopRoot: path.join(data, 'desktop') },
    readPrefs: () => prefs,
    readApprovals: () => new Map(),
    readPrStatuses: () => {
      asked += 1
      return statuses
    },
    write: async text => void writes.push(JSON.parse(text)),
    serverVersion: 'test',
    now: () => NOW,
  })
  await aggregator.run()
  const before = writes.at(-1).sessions.find(s => s.key === key)
  assert.ok(before, 'the desktop session is aggregated')
  assert.notEqual(before.status.bucket, 'needs-you')
  assert.equal(asked, 0, 'off: the PR statuses are not even read')
  prefs = { settings: { prProblemsNeedYou: true } }
  await aggregator.run()
  assert.deepEqual(writes.at(-1).sessions.find(s => s.key === key).status, { bucket: 'needs-you', reason: 'PR checks failing: acme/app#12', since: NOW - 120_000, isObserved: true, isDone: false, snoozedUntil: null })
  prefs = { settings: { prProblemsNeedYou: true }, done: { [key]: NOW } }
  await aggregator.run()
  assert.equal(writes.at(-1).sessions.find(s => s.key === key).status.reason, 'Done', 'Done applies to a PR need as to any need')
})
