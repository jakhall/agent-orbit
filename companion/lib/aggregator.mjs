import { randomBytes } from 'node:crypto'

import { aggregate, createReaders } from '../../shared/aggregate/aggregate.js'
import { statusOf, withPersonMarks } from '../../shared/aggregate/status.js'
import { prProblems } from '../../shared/filters.js'
import { sanitizePrefs } from '../../shared/prefs.js'
import { budgetSnapshot, SNAPSHOT_MAX_BYTES } from '../../shared/aggregate/budget.js'

export const RUN_EVERY_MS = 15_000
export const SETTLE_MS = 300

const AGENT_BUCKETS = { running: 'working', failed: 'failed' }

function agentStatus(agent) {
  const bucket = AGENT_BUCKETS[agent.lifecycle] ?? 'idle'
  const reason = bucket === 'working' ? agent.activity || 'Working' : bucket === 'failed' ? 'Failed' : agent.lifecycle === 'completed' ? 'Finished' : 'Idle'
  return { bucket, reason, since: agent.lastActivityAt ?? null, isObserved: agent.evidence?.confidence === 'observed' }
}

/**
 * Schema 1's aggregate turned into schema 2 (docs/CONTRACT.md "Snapshot
 * v2"): a `status` per session and agent, the server's identity and
 * sequence, no graph; the desktop-record fields (D-3) feed `status`.
 */
export function toV2(v1, { approvals, serverVersion, seq, bootId, watch, now, marks = {}, prNeeds = new Map() }) {
  const { graph: _graph, modVersion: _modVersion, generator: _generator, timings, ...rest } = v1
  const { layoutMs: _layoutMs, ...keptTimings } = timings
  const sessions = v1.sessions.map(s => {
    const facts = { lastFocusedAt: s.lastFocusedAt ?? null, parent: s.parent ?? null, lastReport: s.lastReport ?? null, failure: s.failure ?? null }
    const extra = { approvals: s.cliSessionId ? approvals.get(s.cliSessionId) ?? [] : [], lastFocusedAt: facts.lastFocusedAt, failure: facts.failure, prProblem: prNeeds.get(s.key) ?? null }
    return { ...s, ...facts, status: withPersonMarks(statusOf(s, extra, now), s, marks, now) }
  })
  const agents = v1.agents.map(({ isOwnSession: _isOwn, ...a }) => ({ ...a, status: agentStatus(a) }))
  return { ...rest, schema: 2, generator: 'orbit-server', serverVersion, seq, bootId, sessions, agents, sources: { ...v1.sources, watch }, timings: keptTimings }
}

function signatureOf(v2) {
  const { generatedAt: _at, seq: _seq, timings: _timings, sources, ...stable } = v2
  const { watch: _watch, ...steadySources } = sources
  return JSON.stringify({ ...stable, sources: steadySources })
}

/**
 * The server's one aggregator (A3): runs the shared aggregation over the
 * watched folders, keeps schema 2 in memory, and writes it with `write`
 * only when it changed. `checkedAt` moves on every run, written or not.
 * `noteEvent` marks a watch event; the change it leads to carries the
 * earliest event since the run before (`lastChange`, for G-34 latency).
 */
export function createAggregator({ host, paths, readPrefs, readApprovals, write, serverVersion, now = Date.now, onRun = () => undefined, readAttribution = () => ({ editRoots: new Map(), home: '' }), readPrStatuses = () => null }) {
  const state = {
    bootId: randomBytes(8).toString('hex'),
    seq: 0,
    checkedAt: 0,
    lastRunAt: 0,
    lastMs: 0,
    phases: {},
    isWatching: false,
    lastEventAt: null,
    errors: [],
    snapshot: null,
    lastChange: null,
    isPaused: false,
  }
  const readers = createReaders()
  let signature = ''
  let isRunning = false
  let isQueued = false
  let pendingEventAt = null

  function noteEvent(at) {
    state.lastEventAt = at
    pendingEventAt ??= at
  }

  async function run() {
    if (isRunning) {
      isQueued = true
      return
    }
    isRunning = true
    const eventAt = pendingEventAt
    pendingEventAt = null
    const started = now()
    const phases = {}
    const wallStart = Date.now()
    let mark = wallStart
    const phase = name => {
      const at = Date.now()
      phases[name] = at - mark
      mark = at
    }
    try {
      const prefs = sanitizePrefs(readPrefs())
      phase('prefs')
      state.isPaused = prefs.settings.paused
      if (state.isPaused) return
      const v1 = await aggregate(host, {
        paths,
        readers,
        settings: prefs.settings,
        me: 'orbit-server',
        now: started,
        pinned: prefs.pinned,
        projectOverrides: prefs.projectOverrides,
        titles: prefs.titles,
        tints: prefs.tints,
        projectTints: prefs.projectTints,
        ...readAttribution(),
      })
      phase('aggregate')
      const approvals = readApprovals(started)
      const prNeeds = prefs.settings.prProblemsNeedYou ? prProblems(v1.sessions, readPrStatuses(), started, prefs.hidden) : new Map()
      const watch = { isWatching: state.isWatching, lastEventAt: state.lastEventAt }
      const next = budgetSnapshot(toV2(v1, { approvals, serverVersion, seq: state.seq + 1, bootId: state.bootId, watch, now: started, marks: { done: prefs.done, snoozed: prefs.snoozed }, prNeeds }), SNAPSHOT_MAX_BYTES)
      phase('status')
      const nextSignature = signatureOf(next)
      if (nextSignature !== signature) {
        next.timings = { ...next.timings, phases }
        await write(JSON.stringify(next))
        phase('write')
        signature = nextSignature
        state.seq = next.seq
        state.snapshot = next
        state.lastChange = { seq: next.seq, eventAt, at: Date.now() }
      } else if (state.snapshot) {
        state.snapshot = { ...state.snapshot, generatedAt: started, sources: { ...state.snapshot.sources, watch } }
      }
      state.errors = v1.sources.errors.length > 0 ? ['some sources unreadable'] : []
    } catch (error) {
      state.errors = [`aggregation failed: ${error?.name ?? 'Error'}`]
    } finally {
      state.checkedAt = now()
      state.lastRunAt = started
      state.lastMs = Date.now() - wallStart
      state.phases = phases
      isRunning = false
      onRun(state)
      if (isQueued) {
        isQueued = false
        void run()
      }
    }
  }

  return { state, run, noteEvent }
}
