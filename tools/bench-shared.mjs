// Times what a reader spends on a snapshot outside the map renderer: normalizeSnapshot, withGraph (layout) and visibleOf, at 50 and 300 sessions.
// Usage: node tools/bench-shared.mjs [sessions...]
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { DEFAULT_FILTERS, DEFAULT_SETTINGS } from '../shared/constants.js'
import { normalizeSnapshot, visibleOf } from '../shared/filters.js'
import { withGraph } from '../shared/view.js'

let NOW = Date.now()
let EV = { source: 'mod-events', confidence: 'observed', observedAt: NOW, detail: null }
const BUCKETS = ['working', 'idle', 'review', 'needs-you', 'idle', 'failed']

/** A synthetic schema 2 snapshot; `now` fixed makes it the same every time. */
export function snapshotOf(count, projects = Math.max(3, Math.round(count / 25)), agentsPer = 2, now = NOW) {
  NOW = now
  EV = { source: 'mod-events', confidence: 'observed', observedAt: NOW, detail: null }
  const sessions = []
  const agents = []
  for (let i = 0; i < count; i += 1) {
    const key = `local_${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
    const project = `c:\\repos\\project-${i % projects}`
    const bucket = BUCKETS[i % BUCKETS.length]
    const agentKeys = []
    for (let j = 0; j < agentsPer; j += 1) {
      const agentKey = `${key}/a${j}`
      agentKeys.push(agentKey)
      agents.push({ key: agentKey, id: `a${j}`, sessionKey: key, parentKey: null, type: 'general-purpose', description: `Agent ${j}`, name: null, model: null, lifecycle: j === 0 ? 'running' : 'completed', evidence: EV, phase: 'researching', activity: null, startedAt: NOW - 120_000, lastActivityAt: NOW - j * 60_000, finishedAt: null, recent: [] })
    }
    sessions.push({
      key, localId: key, cliSessionId: `cli-${i}`, title: `Session ${i} working on feature ${i % 17}`, projectId: project, worktreeId: i % 7 === 0 ? `${project}-wt${i}` : project,
      environment: 'desktop', canOpen: true, canMessage: true, cwd: project, branch: 'main', model: 'claude-opus-5-5', effort: null,
      createdAt: NOW - (count - i) * 60_000, lastActivityAt: NOW - i * 30_000, lifecycle: bucket === 'working' ? 'running' : 'idle', lifecycleEvidence: EV, stateSince: NOW - i * 30_000, finishedAt: NOW - i * 30_000,
      phase: 'unknown', phaseEvidence: EV, summary: 'Working on things', activity: null, attention: bucket === 'needs-you' ? 'question' : null, attentionText: bucket === 'needs-you' ? 'Asked you a question' : null,
      isPlanMode: false, context: { percent: null, tokens: null, window: null, evidence: EV }, cost: null, turns: 3, prs: [], agentKeys,
      timeline: Array.from({ length: 12 }, (_, t) => ({ at: NOW - t * 1000, kind: 'tool', text: `Step ${t}` })), stuck: null, publisher: null,
      lastFocusedAt: NOW - 3_600_000, parent: i % 9 === 0 && i > 0 ? { key: `local_${String(i - 1).padStart(8, '0')}-0000-4000-8000-000000000000`, kind: 'side-session' } : null,
      lastReport: { text: 'Finished the change', needsUser: false, ask: null, at: NOW - i * 30_000 }, failure: null, projectSource: 'folder',
      status: { bucket, reason: 'Reason', since: NOW - i * 30_000, isObserved: true, isDone: false, snoozedUntil: null },
    })
  }
  const projectList = [...new Set(sessions.map(s => s.projectId))].map(id => ({ id, name: id.split('\\').at(-1), root: id, remote: null, sessionKeys: sessions.filter(s => s.projectId === id).map(s => s.key), worktreeIds: [...new Set(sessions.filter(s => s.projectId === id).map(s => s.worktreeId))], lastActivityAt: NOW, activeAgents: 0 }))
  const worktreeList = [...new Set(sessions.map(s => s.worktreeId))].map(id => ({ id, projectId: sessions.find(s => s.worktreeId === id).projectId, path: id, isMain: !id.includes('-wt'), branch: 'main', sessionKeys: sessions.filter(s => s.worktreeId === id).map(s => s.key) }))
  return { schema: 2, generatedAt: NOW, generator: 'orbit-server', serverVersion: 'bench', seq: 1, bootId: '0123456789abcdef', projects: projectList, worktrees: worktreeList, sessions, agents, usage: null, sources: { desktop: { ok: true, files: count, parsed: count, failed: 0, error: null }, publishers: { files: 0, live: 0, failed: 0 }, subagents: { metas: agents.length, failed: 0 }, errors: [] }, timings: { aggregateMs: 0, sessions: count, agents: agents.length } }
}

function time(label, fn, runs = 40) {
  for (let i = 0; i < 5; i += 1) fn()
  const samples = []
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now()
    fn()
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  const at = q => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))].toFixed(2)
  console.log(`${label.padEnd(34)} median ${at(0.5)} ms   p90 ${at(0.9)} ms`)
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const counts = process.argv.slice(2).map(Number).filter(n => n > 0)
  for (const count of counts.length ? counts : [50, 300]) {
    const raw = snapshotOf(count)
    console.log(`\n${count} sessions, ${raw.agents.length} sub-agents, ${raw.projects.length} projects`)
    const normalized = normalizeSnapshot(raw)
    const view = withGraph(normalized, {})
    time('normalizeSnapshot', () => normalizeSnapshot(raw))
    time('withGraph (layout)', () => withGraph(normalized, {}))
    time('visibleOf (graph given)', () => visibleOf(normalized, DEFAULT_FILTERS, DEFAULT_SETTINGS, [], NOW, { graph: view.graph }))
    time('all three', () => {
      const n = normalizeSnapshot(raw)
      const v = withGraph(n, {})
      visibleOf(n, DEFAULT_FILTERS, DEFAULT_SETTINGS, [], NOW, { graph: v.graph })
    })
  }
}
