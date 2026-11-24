import { expect, test } from 'claude-code/testing'

import type { SnapshotV2, Status as SessionStatus } from '../types'
import { layoutGraph } from '../shared/layout.js'
import { normalizeSnapshot, visibleOf } from '../shared/filters.js'
import { DEFAULT_FILTERS, DEFAULT_SETTINGS } from '../shared/constants.js'
import { paneSnapshot } from '../src/app'
import { withGraph } from '../shared/view.js'
import { agent, buildSnapshot, NOW, session } from './fixtures'

function serverSnapshot(seq: number): SnapshotV2 {
  const { graph: _graph, timings, ...rest } = buildSnapshot(
    [session('local_0a1b2c3d-0000-4000-8000-000000000001', { title: 'One' }), session('local_0a1b2c3d-0000-4000-8000-000000000002', { title: 'Two', projectId: 'C:\\repo\\other' })],
    [agent('local_0a1b2c3d-0000-4000-8000-000000000001', 'a1')],
  )
  const { layoutMs: _layoutMs, ...kept } = timings
  return { ...rest, seq, timings: kept }
}

test('the pane lays out the graph from the server snapshot with shared/layout.js, once per snapshot and positions (X-3, switch)', () => {
  const v2 = serverSnapshot(7)
  const view = paneSnapshot(v2, {})
  const expected = layoutGraph({ projects: v2.projects, worktrees: v2.worktrees, sessions: v2.sessions, agents: v2.agents }, {})
  expect(view?.graph).toEqual(expected)
  expect(typeof view?.timings.layoutMs).toBe('number')
  expect(paneSnapshot(v2, {})).toBe(view)
  const moved = paneSnapshot(v2, { 's:local_0a1b2c3d-0000-4000-8000-000000000001': { dx: 40, dy: 0 } })
  expect(moved).not.toBe(view)
  expect(paneSnapshot(serverSnapshot(8), {})).not.toBe(moved)
  expect(paneSnapshot(null, {})).toBe(null)
})

test('visibleOf takes the reader graph as an option; a v2 snapshot has none of its own (switch)', () => {
  const v2 = serverSnapshot(1)
  const graph = layoutGraph({ projects: v2.projects, worktrees: v2.worktrees, sessions: v2.sessions, agents: v2.agents }, {})
  const visible = visibleOf(v2, DEFAULT_FILTERS, DEFAULT_SETTINGS, [], NOW, { graph })
  expect(visible.nodes.length).toBeGreaterThan(0)
  expect(visibleOf(v2, DEFAULT_FILTERS, DEFAULT_SETTINGS, [], NOW).nodes.length).toBe(0)
})

test('normalizeSnapshot fills a missing status from lifecycle and attention, and reads an unknown bucket as idle (switch)', () => {
  const v2 = serverSnapshot(1)
  const raw = {
    ...v2,
    sessions: [
      { ...v2.sessions[0]!, lifecycle: 'waiting-user' as const, attention: 'question' as const, attentionText: 'Asked you a question', status: undefined },
      { ...v2.sessions[1]!, status: { bucket: 'snoozing', reason: 'x', since: null, isObserved: true } as unknown as SessionStatus },
    ],
  }
  const read = normalizeSnapshot(raw)
  expect(read.sessions[0]?.status).toEqual({ bucket: 'needs-you', reason: 'Asked you a question', since: read.sessions[0]?.stateSince ?? null, isObserved: false })
  expect(read.sessions[1]?.status?.bucket).toBe('idle')
  expect(read.agents.every(a => a.status !== undefined)).toBe(true)
})

test('a tier below detail lays out no sub-agent satellites and no edges to them; the full tier keeps them (C10)', () => {
  const v2 = serverSnapshot(3)
  const full = withGraph(v2, {})
  expect(full.graph.nodes.some(n => n.kind === 'agent')).toBe(true)
  for (const tier of [0, 1] as const) {
    const pane = withGraph(v2, {}, { tier })
    expect(pane.graph.nodes.some(n => n.kind === 'agent')).toBe(false)
    const ids = new Set(pane.graph.nodes.map(n => n.id))
    expect(pane.graph.edges.every(e => ids.has(e.from) && ids.has(e.to))).toBe(true)
    expect(pane.graph.nodes.length).toBe(full.graph.nodes.filter(n => n.kind !== 'agent').length)
  }
  expect(withGraph(v2, {}, { tier: 2 }).graph).toEqual(full.graph)
  expect(paneSnapshot(v2, {}, 1)).not.toBe(paneSnapshot(v2, {}, 2))
})

test('2.1 Option 1: the pane packs only projects with a session in the time window; a search change reuses the layout, a window change packs again', () => {
  const base = serverSnapshot(9)
  const v2 = { ...base, sessions: base.sessions.map(x => (x.projectId !== 'C:\\repo\\other' ? { ...x, lastActivityAt: NOW - 3 * 86_400_000 } : { ...x, lastActivityAt: NOW - 60_000 })) }
  const window = { filters: { ...DEFAULT_FILTERS }, pinned: [] as string[], now: NOW }
  const view = paneSnapshot(v2, {}, 2, window)
  const pack = new Set([v2.sessions[1]!.projectId])
  expect(view?.graph).toEqual(withGraph(v2, {}, { pack }).graph)
  expect(view?.graph).not.toEqual(withGraph(v2, {}).graph)
  expect(paneSnapshot(v2, {}, 2, { ...window, filters: { ...DEFAULT_FILTERS, search: 'one', attentionOnly: true } })).toBe(view)
  const all = paneSnapshot(v2, {}, 2, { ...window, filters: { ...DEFAULT_FILTERS, time: 'all' } })
  expect(all).not.toBe(view)
  expect(all?.graph).toEqual(withGraph(v2, {}).graph)
})
