import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { DEFAULT_FILTERS, DEFAULT_SETTINGS } from '../../shared/constants.js'
import { normalizeSnapshot, visibleOf } from '../../shared/filters.js'
import { snapshotOf } from '../../tools/bench-shared.mjs'

const NOW = 1_800_000_000_000
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

/** A graph built here, not by `shared/layout.js`, so the test pins only what this file's code does (B's layout may change freely). */
function fixedGraph(snapshot) {
  const node = (id, kind, ref, parent, i) => ({ id, kind, ref, parent, x: i * 10, y: i * 5, r: 8, label: ref.slice(-12), side: 1 })
  const nodes = []
  const edges = []
  snapshot.projects.forEach((p, i) => nodes.push(node(`p:${p.id}`, 'project', p.id, null, i)))
  snapshot.worktrees.forEach((w, i) => {
    nodes.push(node(`w:${w.id}`, 'worktree', w.id, `p:${w.projectId}`, i))
    edges.push({ from: `p:${w.projectId}`, to: `w:${w.id}`, kind: 'hierarchy' })
  })
  snapshot.sessions.forEach((s, i) => {
    nodes.push(node(`s:${s.key}`, 'session', s.key, `p:${s.projectId}`, i))
    edges.push({ from: `p:${s.projectId}`, to: `s:${s.key}`, kind: 'hierarchy' })
  })
  snapshot.agents.forEach((a, i) => {
    nodes.push(node(`a:${a.key}`, 'agent', a.key, `s:${a.sessionKey}`, i))
    edges.push({ from: `s:${a.sessionKey}`, to: `a:${a.key}`, kind: 'hierarchy' })
  })
  return { nodes, edges }
}

function outputs() {
  const raw = snapshotOf(120, 6, 3, NOW)
  const n = normalizeSnapshot(raw)
  const graph = fixedGraph(n)
  const keyOf = i => n.sessions[i].key
  const runs = [
    [DEFAULT_FILTERS, DEFAULT_SETTINGS, [], {}],
    [{ ...DEFAULT_FILTERS, time: '1h', showCompleted: false }, DEFAULT_SETTINGS, [], {}],
    [{ ...DEFAULT_FILTERS, search: 'feature 3', attentionOnly: false }, { ...DEFAULT_SETTINGS, maxSubagents: 1 }, [`p:${n.sessions[0].projectId}`], { pinned: [keyOf(5)], expanded: [keyOf(1)], showAll: [keyOf(2)], hidden: { [keyOf(3)]: NOW } }],
    [{ ...DEFAULT_FILTERS, attentionOnly: true, project: n.sessions[1].projectId }, { ...DEFAULT_SETTINGS, showPRs: true }, [`s:${keyOf(1)}`], { hidden: { [keyOf(4)]: NOW + 1 } }],
  ]
  return { normalized: hash(n), visible: runs.map(([f, s, c, o]) => hash(visibleOf(n, f, s, c, NOW, { ...o, graph }))) }
}

test('normalizeSnapshot and visibleOf give the results pinned at the performance pass, re-pinned in 2.1.5 when main-checkout diamonds left the map (layout not involved)', () => {
  assert.deepEqual(outputs(), GOLDEN)
})

const GOLDEN = { normalized: '5b7d6b1d4ed35bb8', visible: ['3c49d7df6f071ca6', '93dd7aa96fd8b04b', 'c2cb114d6d49e07a', '8ce75e1b208db63c'] }
