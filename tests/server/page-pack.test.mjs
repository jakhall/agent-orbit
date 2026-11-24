import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_FILTERS } from '../../shared/constants.js'
import { normalizeSnapshot, packedProjects } from '../../shared/filters.js'
import { layoutGraph } from '../../shared/layout.js'
import { layoutKeyOf, withLayout } from '../../shared/popout.js'
import { snapshotOf } from '../../tools/bench-shared.mjs'

const NOW = 1_800_000_000_000

function offWindow() {
  const n = normalizeSnapshot(snapshotOf(60, 6, 3, NOW))
  const old = new Set(n.projects.map(p => p.id).filter((_, i) => i % 2 === 0))
  return { ...n, sessions: n.sessions.map(x => (old.has(x.projectId) ? { ...x, lastActivityAt: NOW - 3 * 86_400_000 } : x)) }
}

test('2.1 packing: the page lays out with the packed projects first, as layoutGraph does with { pack }', () => {
  const n = offWindow()
  const pack = packedProjects(n, { ...DEFAULT_FILTERS }, NOW)
  assert.ok(pack.size > 0 && pack.size < n.projects.length)
  assert.deepEqual(withLayout(n, {}, { pack }).graph, layoutGraph(n, {}, { pack }))
  assert.notDeepEqual(withLayout(n, {}, { pack }).graph, withLayout(n, {}).graph)
})

test('2.1 packing: the page lays out again when the packed projects change, not when their order does', () => {
  const stamp = { bootId: 'b', seq: 4 }
  const a = layoutKeyOf(stamp, {}, new Set(['p1', 'p2']))
  assert.equal(layoutKeyOf(stamp, {}, new Set(['p2', 'p1'])), a)
  assert.notEqual(layoutKeyOf(stamp, {}, new Set(['p1'])), a)
  assert.notEqual(layoutKeyOf({ ...stamp, seq: 5 }, {}, new Set(['p1', 'p2'])), a)
  assert.notEqual(layoutKeyOf(stamp, { p1: { dx: 1, dy: 2 } }, new Set(['p1', 'p2'])), a)
})
