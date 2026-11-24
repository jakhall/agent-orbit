import { expect, test } from 'claude-code/testing'

import type { AgentView, GraphNode, SessionView } from '../types'
import { agentFan, layoutGraph } from '../shared/layout.js'
import { agent, buildSnapshot, NOW, session } from './fixtures'

const ONE = 'c:\\repos\\one'
const TWO = 'c:\\repos\\two'

function input(sessions: SessionView[], agents: AgentView[] = []) {
  const snap = buildSnapshot(sessions, agents)
  return { projects: snap.projects, worktrees: snap.worktrees, sessions: snap.sessions, agents: snap.agents }
}

const base = () => [
  session('local_a', { projectId: ONE, worktreeId: ONE, createdAt: NOW - 50_000, prs: [{ url: 'https://github.com/o/r/pull/7', number: 7, repo: 'o/r', branch: 'b', state: 'OPEN' }] }),
  session('local_b', { projectId: ONE, worktreeId: null, createdAt: NOW - 40_000 }),
  session('cli:c', { projectId: TWO, worktreeId: null, createdAt: NOW - 30_000, localId: null }),
]
const baseAgents = () => [agent('local_a', 'x1', { startedAt: NOW - 20_000 }), agent('local_a', 'x2', { startedAt: NOW - 10_000, parentKey: 'local_a/x1' })]
const byId = (nodes: GraphNode[]) => new Map(nodes.map(n => [n.id, n]))

test('the same input lays out the same, whatever order its lists come in (layout handover)', () => {
  const first = layoutGraph(input(base(), baseAgents()), {})
  const again = layoutGraph(input(base(), baseAgents()), {})
  expect(again).toEqual(first)
  const shuffled = input([...base()].reverse(), [...baseAgents()].reverse())
  const fromShuffled = layoutGraph({ ...shuffled, projects: [...shuffled.projects].reverse() }, {})
  expect([...byId(fromShuffled.nodes)].sort()).toEqual([...byId(first.nodes)].sort())
})

test('status never moves a node: lifecycle, attention, activity and status changes keep every position', () => {
  const calm = layoutGraph(input(base(), baseAgents()), {})
  const busy = base().map(s => ({ ...s, lifecycle: 'running' as const, attention: 'question' as const, activity: 'Running tests', lastActivityAt: NOW }))
  const moved = layoutGraph(input(busy, baseAgents().map(a => ({ ...a, lifecycle: 'completed' as const }))), {})
  expect(moved.nodes.map(n => [n.id, n.x, n.y])).toEqual(calm.nodes.map(n => [n.id, n.x, n.y]))
})

test('a new, younger session in a project leaves the existing sessions where they were relative to their project', () => {
  const before = byId(layoutGraph(input(base()), {}).nodes)
  const after = byId(layoutGraph(input([...base(), session('local_d', { projectId: ONE, worktreeId: null, createdAt: NOW - 1_000 })]), {}).nodes)
  for (const key of ['local_a', 'local_b']) {
    const relative = (nodes: Map<string, GraphNode>) => {
      const s = nodes.get(`s:${key}`)
      const p = nodes.get(`p:${ONE}`)
      return s && p ? [Math.round(s.x - p.x), Math.round(s.y - p.y)] : null
    }
    expect(relative(after)).toEqual(relative(before))
  }
})

test('a dragged node keeps its saved offset from its parent', () => {
  const free = byId(layoutGraph(input(base(), baseAgents()), {}).nodes)
  const dragged = byId(layoutGraph(input(base(), baseAgents()), { 's:local_b': { dx: 10, dy: -20 } }).nodes)
  const project = dragged.get(`p:${ONE}`)
  expect([dragged.get('s:local_b')?.x, dragged.get('s:local_b')?.y]).toEqual([(project?.x ?? 0) + 10, (project?.y ?? 0) - 20])
  expect(dragged.get('s:local_a')).toEqual(free.get('s:local_a'))
})

test('the graph shape is schema 1\'s: node ids by kind, parents and edges (layout handover)', () => {
  const graph = layoutGraph(input(base(), baseAgents()), {})
  expect(graph.nodes.map(n => [n.id, n.kind, n.parent])).toEqual([
    [`p:${ONE}`, 'project', null],
    [`w:${ONE}`, 'worktree', `p:${ONE}`],
    ['s:local_a', 'session', `p:${ONE}`],
    ['a:local_a/x1', 'agent', 's:local_a'],
    ['a:local_a/x2', 'agent', 's:local_a'],
    ['pr:local_a#7', 'pr', 's:local_a'],
    ['s:local_b', 'session', `p:${ONE}`],
    [`p:${TWO}`, 'project', null],
    ['s:cli:c', 'session', `p:${TWO}`],
  ])
  expect(graph.edges).toEqual([
    { from: `p:${ONE}`, to: `w:${ONE}`, kind: 'resource' },
    { from: `p:${ONE}`, to: 's:local_a', kind: 'hierarchy' },
    { from: 's:local_a', to: `w:${ONE}`, kind: 'resource' },
    { from: 's:local_a', to: 'a:local_a/x1', kind: 'hierarchy' },
    { from: 'a:local_a/x1', to: 'a:local_a/x2', kind: 'hierarchy' },
    { from: 's:local_a', to: 'pr:local_a#7', kind: 'resource' },
    { from: `p:${ONE}`, to: 's:local_b', kind: 'hierarchy' },
    { from: `p:${TWO}`, to: 's:cli:c', kind: 'hierarchy' },
  ])
  for (const n of graph.nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true)
})

test('subagents sit on one arc of equal spokes facing away from the hub, a further staggered arc past seven, a nested agent extending its parent\'s spoke', () => {
  const outward = 0.7
  const many = Array.from({ length: 10 }, (_, i) => agent('local_a', `r${i}`, { startedAt: NOW - 100_000 + i }))
  const child = agent('local_a', 'kid', { startedAt: NOW, parentKey: 'local_a/r0' })
  const fan = agentFan([...many, child], outward)
  const firstArc = many.slice(0, 7).map(a => fan.get(a.key)!)
  for (const at of firstArc) {
    expect(at.radius).toBe(68)
    expect(Math.abs(at.angle - outward)).toBeLessThanOrEqual(1.2 + 1e-9)
  }
  for (let i = 1; i < firstArc.length; i += 1) expect(Math.abs(firstArc[i]!.angle - firstArc[i - 1]!.angle - 0.4)).toBeLessThan(1e-9)
  const secondArc = many.slice(7).map(a => fan.get(a.key)!)
  for (const at of secondArc) {
    expect(at.radius).toBe(98)
    expect(firstArc.some(f => Math.abs(f.angle - at.angle) < 0.1)).toBe(false)
  }
  expect(fan.get(child.key)).toEqual({ angle: fan.get('local_a/r0')!.angle, radius: 98 })
  expect(agentFan(many.slice(0, 1), outward).get('local_a/r0')).toEqual({ angle: outward, radius: 68 })
  const two = agentFan(many.slice(0, 2), outward)
  expect([...two.values()].map(at => at.angle)).toEqual([outward - 0.2, outward + 0.2])
})

test('a session\'s PRs sit beyond its subagents', () => {
  const agents = Array.from({ length: 12 }, (_, i) => agent('local_a', `r${i}`, { startedAt: NOW - 100_000 + i }))
  const { nodes } = layoutGraph(input(base(), agents), {})
  const at = byId(nodes)
  const s = at.get('s:local_a')!
  const far = (id: string) => Math.hypot(at.get(id)!.x - s.x, at.get(id)!.y - s.y)
  const reach = Math.max(...agents.map(a => far(`a:${a.key}`)))
  expect(far('pr:local_a#7')).toBeGreaterThan(reach + 20)
})
