import { expect, test } from 'claude-code/testing'

import { layoutGraph } from '../shared/layout.js'
import { ageText, bucketAge, fitMap, mapParts, projectChoices, sessionName, tierFor } from '../shared/map.js'
import { lookupOf } from '../shared/render.js'
import { synthetic } from './fixtures'

const STAGE = { w: 1160, h: 856 }
const NOW = 1_800_000_000_000

const withFamily = () => {
  const base = synthetic(4, 12, 2)
  const [a, c] = base.sessions
  const b = base.sessions[4]
  const sessions = base.sessions.map(s =>
    s.key === b!.key ? { ...s, parent: { key: a!.key, kind: 'fork' as const }, projectSource: 'edits' as const } : s.key === c!.key ? { ...s, parent: { key: 'local_gone', kind: 'side-session' as const } } : s,
  )
  return { snapshot: { ...base, sessions }, a: a!, b: b!, c: c! }
}

test('C3 G-16: each session whose parent is listed gets a lineage edge from the parent; an absent parent draws none', () => {
  const { snapshot, a, b, c } = withFamily()
  const graph = layoutGraph(snapshot, {})
  const lineage = graph.edges.filter(e => e.kind === 'lineage')
  expect(lineage).toEqual([{ from: `s:${a.key}`, to: `s:${b.key}`, kind: 'lineage' }])
  expect(lineage.some(e => e.to === `s:${c.key}`)).toBe(false)
})

const draw = (selected: string | null, zoom = 1) => {
  const { snapshot, a, b } = withFamily()
  const graph = layoutGraph(snapshot, {})
  const fit = fitMap(graph.nodes, STAGE, 32)
  const camera = { ...fit, w: fit.w / zoom, h: fit.h / zoom }
  const parts = mapParts(graph.nodes, graph.edges, lookupOf({ ...snapshot, graph } as never), { camera, stagePx: STAGE, selected, now: NOW, overflow: { [`s:${a.key}`]: { count: 4, reason: 'cap', noun: 'subagent' } } })
  return { parts, a, b, k: STAGE.w / camera.w }
}

test('C3: lineage is drawn for the selected session’s family below the detail tier, and for everyone at the detail tier', () => {
  const none = draw(null, 0.5)
  if (tierFor(none.k) < 2) expect(none.parts.edges.some(e => e.id.startsWith('lineage:'))).toBe(false)
  const family = draw(`s:${none.b.key}`, 0.5)
  expect(family.parts.edges.some(e => e.id === `lineage:s:${none.a.key}>s:${none.b.key}`)).toBe(true)
  const detail = draw(null, 6)
  expect(tierFor(detail.k)).toBe(2)
  expect(detail.parts.edges.some(e => e.id.startsWith('lineage:'))).toBe(true)
})

test('C3: every session dot carries its name, bucket, reason, age, project and how it was placed, as its text name', () => {
  const { parts, b } = draw(null)
  const node = parts.nodes.find(p => p.id === `s:${b.key}`)!
  const title = /<title>([^<]*)<\/title>/.exec(node.markup)?.[1] ?? ''
  expect(title).toContain(b.title)
  expect(title).toMatch(/Idle|Working|Needs you|Failed|Ready for review/)
  expect(title).toContain('by its edits')
  expect(title).not.toContain('placed')
  expect(title).toContain('Forked from')
})

test('C3: age reads in coarse steps, so a node’s markup changes at most hourly', () => {
  expect(ageText(NOW - 10 * 60_000, NOW)).toBe('active in the last hour')
  expect(ageText(NOW - 3 * 3_600_000, NOW)).toBe('active 3h ago')
  expect(ageText(NOW - 3 * 86_400_000, NOW)).toBe('active 3d ago')
  expect(ageText(null, NOW)).toBe('no activity yet')
})

test('C3 review #8: the text name does not repeat the bucket, and its age is the bucket’s own (waiting, failed) like the rail', () => {
  const lookup = { sessions: new Map(), projects: new Map() }
  const working = { title: 'T', projectId: 'p', lastActivityAt: NOW - 10 * 60_000, status: { bucket: 'working', reason: 'Working (no recent tool call)', since: NOW - 60_000 } } as never
  expect(sessionName(working, 'working', lookup as never, NOW).split('\n')[1]).toBe('Working · no recent tool call · active in the last hour')
  const stale = { title: 'T', projectId: 'p', lastActivityAt: NOW, status: { bucket: 'working', reason: 'No activity for 12m · may be stuck', since: NOW } } as never
  expect(sessionName(stale, 'working', lookup as never, NOW).split('\n')[1]).toBe('Working · No activity for 12m · may be stuck')
  const waiting = { title: 'T', projectId: 'p', lastActivityAt: NOW, status: { bucket: 'needs-you', reason: 'Asked you a question', since: NOW - 3 * 3_600_000 } } as never
  expect(sessionName(waiting, 'needs-you', lookup as never, NOW).split('\n')[1]).toBe('Needs you · Asked you a question · waiting 3h')
  expect(bucketAge('failed', NOW - 2 * 3_600_000, NOW, NOW)).toBe('failed 2h ago')
  const asks = { title: 'T', projectId: 'p', lastActivityAt: NOW, lastReport: { ask: 'Can I run the migration?' } } as never
  expect(sessionName(asks, 'idle', lookup as never, NOW, 3)).toContain('Asks: Can I run the migration?')
  expect(sessionName(asks, 'idle', lookup as never, NOW, 3)).toContain('3 more sub-agents not drawn')
})

test('C3: at the detail tier a session with sub-agents past the cap says how many are not drawn', () => {
  const { parts, a } = draw(null, 6)
  const node = parts.nodes.find(p => p.id === `s:${a.key}`)!
  expect(node.markup).toContain('+4')
})

test('C3 G-17: the project override offers every project by name, with Automatic first', () => {
  const choices = projectChoices([{ id: 'b', name: 'beta' }, { id: 'a', name: 'alpha' }] as never, 'b', 'alpha')
  expect(choices).toEqual([
    { value: '', label: 'Automatic (alpha)', isCurrent: false },
    { value: 'a', label: 'alpha', isCurrent: false },
    { value: 'b', label: 'beta', isCurrent: true },
  ])
})

