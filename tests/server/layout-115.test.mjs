import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { normalizeSnapshot, packedProjects } from '../../shared/filters.js'
import { DEFAULT_FILTERS } from '../../shared/constants.js'
import { fitMap } from '../../shared/map.js'
import { layoutGraph } from '../../shared/layout.js'
import { snapshotOf } from '../../tools/bench-shared.mjs'

const NOW = 1_800_000_000_000
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

/** What 1.15.2's layout (`shared/layout.js` at `345091f`, the port of `src/graph/layout.ts` at `orbit-1.15.2`) gives on this input without its satellites; lineage edges are 2.0's and checked apart. */
const LAYOUT_115 = { plain: '2967279af6e0eb2c', dragged: '5fa2e787ec253938' }
/** The same input with 2.2.20's arc of satellites. */
const LAYOUT_ARC = { plain: '77b9b9bf39b2d114', dragged: '86e9106676425b42' }

const withoutLineage = graph => ({ nodes: graph.nodes, edges: graph.edges.filter(e => e.kind !== 'lineage') })
const withoutAgents = graph => ({ nodes: graph.nodes.filter(n => n.kind !== 'agent'), edges: graph.edges.filter(e => e.kind !== 'lineage') })

test('R1: the map is laid out as in 1.15.2 (hubs, spokes, rings of sessions, worktrees), a dragged node included; satellites sit on an arc since 2.2.20', () => {
  const n = normalizeSnapshot(snapshotOf(120, 6, 3, NOW))
  const dragged = { [`s:${n.sessions[3].key}`]: { dx: 40, dy: -25 } }
  assert.equal(hash(withoutAgents(layoutGraph(n, {}))), LAYOUT_115.plain)
  assert.equal(hash(withoutAgents(layoutGraph(n, dragged))), LAYOUT_115.dragged)
  assert.equal(hash(withoutLineage(layoutGraph(n, {}))), LAYOUT_ARC.plain)
  assert.equal(hash(withoutLineage(layoutGraph(n, dragged))), LAYOUT_ARC.dragged)
})

test('R1: lineage edges from 2.0 stay: one per session whose parent is on the map', () => {
  const n = normalizeSnapshot(snapshotOf(120, 6, 3, NOW))
  const lineage = layoutGraph(n, {}).edges.filter(e => e.kind === 'lineage')
  const expected = n.sessions.filter(s => s.parent && s.parent.key !== s.key && n.sessions.some(p => p.key === s.parent.key)).map(s => `s:${s.parent.key}>s:${s.key}`).sort()
  assert.ok(expected.length > 0)
  assert.deepEqual(lineage.map(e => `${e.from}>${e.to}`).sort(), expected)
})

test('2.3: a dragged hub stays where it is dropped, even onto another cluster, and no other cluster moves', () => {
  const n = normalizeSnapshot(snapshotOf(120, 6, 3, NOW))
  const plain = layoutGraph(n, {})
  const hubs = plain.nodes.filter(x => x.kind === 'project')
  const [moved, target] = [hubs[0], hubs[2]]
  for (const drop of [{ dx: target.x + 40, dy: target.y - 30 }, { dx: hubs[1].x - 450, dy: hubs[1].y }]) {
    const graph = layoutGraph(n, { [moved.id]: drop })
    const at = id => graph.nodes.find(x => x.id === id)
    assert.deepEqual([at(moved.id).x, at(moved.id).y], [drop.dx, drop.dy])
    for (const other of hubs.filter(x => x.id !== moved.id)) assert.deepEqual([at(other.id).x, at(other.id).y], [other.x, other.y], `${other.id} moved`)
  }
})

function offWindow() {
  const n = normalizeSnapshot(snapshotOf(120, 6, 3, NOW))
  const old = new Set(n.projects.map(p => p.id).filter((_, i) => i % 3 !== 1))
  const kept = new Map()
  const sessions = n.sessions
    .filter(x => old.has(x.projectId) || (kept.set(x.projectId, (kept.get(x.projectId) ?? 0) + 1), kept.get(x.projectId) <= 3))
    .map(x => (old.has(x.projectId) ? { ...x, lastActivityAt: NOW - 3 * 86_400_000 } : x))
  return { ...n, sessions, old }
}

test('2.1 Option 1: the projects packed are those with a session in the time window or a pinned one; search, bucket and project filters never change them', () => {
  const n = offWindow()
  const filters = { ...DEFAULT_FILTERS }
  const pack = packedProjects(n, filters, NOW)
  assert.deepEqual([...pack].sort(), n.projects.map(p => p.id).filter(id => !n.old.has(id)).sort())
  for (const other of [{ search: 'feature 3' }, { attentionOnly: true }, { project: [...pack][0] }, { showCompleted: false, showStale: false }]) {
    assert.deepEqual([...packedProjects(n, { ...filters, ...other }, NOW)].sort(), [...pack].sort())
  }
  const oldKey = n.sessions.find(x => n.old.has(x.projectId)).key
  assert.ok(packedProjects(n, filters, NOW, [oldKey]).has(n.sessions.find(x => x.key === oldKey).projectId))
  assert.equal(packedProjects(n, { ...filters, time: 'all' }, NOW).size, n.projects.length)
})

test('2.1 Option 1: in-window clusters are laid out exactly as 1.15 lays out those projects alone, so Fit matches; off-window projects still get places, after them', () => {
  const n = offWindow()
  const pack = packedProjects(n, { ...DEFAULT_FILTERS }, NOW)
  const packed = layoutGraph(n, {}, { pack })
  const alone = layoutGraph({ ...n, projects: n.projects.filter(p => pack.has(p.id)), sessions: n.sessions.filter(x => pack.has(x.projectId)) }, {})
  const inWindow = graph => graph.nodes.filter(x => !n.old.has((x.kind === 'project' ? x.ref : graph.nodes.find(h => h.id === hubOf(graph, x))?.ref) ?? ''))
  const at = graph => new Map(inWindow(graph).map(x => [x.id, [x.x, x.y]]))
  assert.deepEqual(at(packed), at(alone))
  assert.equal(packed.nodes.filter(x => x.kind === 'project').length, n.projects.length)
  const stage = { w: 1160, h: 856 }
  const k = graph => stage.w / fitMap(inWindow(graph), stage, 32).w
  const unpacked = layoutGraph(n, {})
  assert.equal(Math.round(k(packed) * 1000), Math.round(k(alone) * 1000))
  assert.ok(k(packed) > k(unpacked), `packed ${k(packed)} vs ${k(unpacked)}`)
  assert.equal(hash(withoutLineage(layoutGraph(n, {}, { pack: new Set(n.projects.map(p => p.id)) }))), hash(withoutLineage(unpacked)))
})

function hubOf(graph, node) {
  let at = node
  for (let i = 0; i < 6 && at && at.kind !== 'project'; i += 1) at = graph.nodes.find(x => x.id === at.parent)
  return at?.id
}
