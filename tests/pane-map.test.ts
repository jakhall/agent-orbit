import { expect, test } from 'claude-code/testing'

import { PALETTE, PALETTE_LIGHT } from '../shared/constants.js'
import { normalizeSnapshot } from '../shared/filters.js'
import { countOutside, countOverlaps, tierFor } from '../shared/map.js'
import { lookupOf } from '../shared/render.js'
import { withGraph } from '../shared/view.js'
import { armLine, errorsLine, noticeLine } from '../src/ui/diag-lines'
import { withLocalMarks } from '../src/ui/marks'
import { paneMap } from '../src/ui/pane-map'
import { bucketed, buildSnapshot, NOW, session } from './fixtures'

const DOCK = { w: 432, h: 508 }
const INLINE = { w: 432, h: 216 }
const FIT = { zoom: 1, panX: 0, panY: 0 }

function paneGraph(count = 50, projects = 10) {
  const view = withGraph(normalizeSnapshot(bucketed(count, projects)), {}, { tier: 1 })
  return { view, lookup: lookupOf(view) }
}

const fontPx = (svg: string, k: number) => [...svg.matchAll(/<text[^>]*font-size="([\d.]+)"/g)].map(m => Number(m[1]) * k)

test('C10, 2.1: the pane map at Fit is the Overview or Sessions tier, every title at least 10 px (1.15’s floor), none overlapping or off the stage, dock and inline', () => {
  const { view, lookup } = paneGraph()
  for (const stagePx of [DOCK, INLINE]) {
    const map = paneMap(view.graph.nodes, view.graph.edges, lookup, { stagePx, camera: FIT, selected: null, now: NOW })
    expect(map.tier).toBe(tierFor(map.k))
    expect(map.tier).toBeLessThan(2)
    expect(map.labels.size).toBeGreaterThan(0)
    expect(fontPx(map.svg, map.k).length).toBeGreaterThan(0)
    for (const l of map.labels.values()) if (l.kind === 'title') expect(l.px ?? 0).toBeGreaterThanOrEqual(9.99)
    const boxes = [...map.labels.values()].map(l => l.box)
    expect(countOverlaps(boxes)).toBe(0)
    expect(countOutside(boxes, { x: 0, y: 0, ...stagePx })).toBe(0)
    expect(map.svg).not.toContain('k-agent')
    expect(map.svg.startsWith('<svg')).toBe(true)
    expect(map.svg).toContain(`width="${stagePx.w}"`)
  }
})

test('C10: a needs-you session the pane map cannot label is still counted in its cluster name', () => {
  const { view, lookup } = paneGraph()
  const map = paneMap(view.graph.nodes, view.graph.edges, lookup, { stagePx: DOCK, camera: FIT, selected: null, now: NOW })
  const needs = view.graph.nodes.filter(n => n.kind === 'session' && (lookup.sessions.get(n.ref) as { status?: { bucket: string } } | undefined)?.status?.bucket === 'needs-you')
  expect(needs.length).toBeGreaterThan(0)
  for (const n of needs) {
    if (map.labels.has(n.id)) continue
    expect(map.labels.get(n.parent ?? '')?.sub ?? '').toContain('need')
  }
})

test('C10: zooming the pane camera in raises the tier and keeps labels apart; Fit is the camera at zoom 1', () => {
  const { view, lookup } = paneGraph()
  const fit = paneMap(view.graph.nodes, view.graph.edges, lookup, { stagePx: DOCK, camera: FIT, selected: null, now: NOW })
  const near = paneMap(view.graph.nodes, view.graph.edges, lookup, { stagePx: DOCK, camera: { zoom: 6, panX: 0, panY: 0 }, selected: null, now: NOW })
  expect(near.k).toBeGreaterThan(fit.k)
  expect(near.tier).toBeGreaterThan(fit.tier)
  expect(countOverlaps([...near.labels.values()].map(l => l.box))).toBe(0)
  expect(near.fit).toEqual(fit.fit)
  expect(fit.view).toEqual(fit.fit)
})

test('C10: the selected session is labelled and ringed in the pane map', () => {
  const { view, lookup } = paneGraph()
  const id = view.graph.nodes.find(n => n.kind === 'session' && (lookup.sessions.get(n.ref) as { status?: { bucket: string } } | undefined)?.status?.bucket === 'idle')?.id ?? ''
  const map = paneMap(view.graph.nodes, view.graph.edges, lookup, { stagePx: DOCK, camera: FIT, selected: id, now: NOW })
  expect(map.labels.has(id)).toBe(true)
})

test('C10: Diagnostics names the arm switches in the page words, the notice, and E-29 errors', () => {
  expect(armLine([])).toBe('Remote control: off')
  expect(armLine(null)).toBe('Remote control: not known yet')
  expect(armLine(['approvals', 'replies'])).toBe('Remote control on, all windows: Approvals, Replies as me')
  expect(noticeLine(null)).toBe('Notice: none')
  expect(noticeLine('Orbit server is not running')).toBe('Notice: Orbit server is not running')
  expect(errorsLine(null, NOW)).toBe('Errors: none')
  expect(errorsLine({ count: 3, lastAt: NOW - 120_000, where: 'publish', kind: 'EBUSY' }, NOW)).toBe('Errors: 3 errors, last 2m ago in publish (EBUSY)')
  expect(errorsLine({ count: 1, lastAt: NOW - 1_000, where: 'hook', kind: 'Error' }, NOW)).toBe('Errors: 1 error, last just now in hook (Error)')
})

test('C6 adoption: the pane map follows a light host: every colour it draws has its PALETTE_LIGHT twin under prefers-color-scheme: light', () => {
  const { view, lookup } = paneGraph()
  const map = paneMap(view.graph.nodes, view.graph.edges, lookup, { stagePx: DOCK, camera: FIT, selected: view.graph.nodes.find(n => n.kind === 'session')?.id ?? null, now: NOW })
  const style = /<style>@media \(prefers-color-scheme: light\)\{(.*)\}<\/style>/.exec(map.svg)?.[1] ?? ''
  expect(style.length).toBeGreaterThan(0)
  const drawn = new Set([...map.svg.matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]{3,8})"/g)].map(m => m[1]!.toLowerCase()))
  expect(drawn.size).toBeGreaterThan(3)
  const swaps = new Map([...style.matchAll(/\[(fill|stroke)="(#[0-9A-Fa-f]{3,8})" i\]\{\1:(#[0-9A-Fa-f]{3,8})\}/g)].map(m => [`${m[1]} ${m[2]!.toLowerCase()}`, m[3]]))
  for (const hex of drawn) expect(swaps.has(`fill ${hex}`) || swaps.has(`stroke ${hex}`)).toBe(true)
  expect(swaps.get(`fill ${PALETTE.bg.toLowerCase()}`)).toBe(PALETTE_LIGHT.bg)
  expect(swaps.get(`fill ${PALETTE.amber.toLowerCase()}`)).toBe(PALETTE_LIGHT.amber)
})

test('C6 review A1: local marks fold Done in as the server does, and leave the snapshot as it is when nothing changes', () => {
  const snapshot = normalizeSnapshot(bucketed(12, 3))
  expect(withLocalMarks(snapshot, { done: {}, snoozed: {} }, NOW)).toBe(snapshot)
  const key = snapshot.sessions.find(s => s.status?.bucket === 'needs-you')?.key ?? ''
  const marked = withLocalMarks(snapshot, { done: { [key]: NOW }, snoozed: {} }, NOW)
  expect(marked.sessions.find(s => s.key === key)?.status).toMatchObject({ bucket: 'idle', reason: 'Done' })
  expect(withLocalMarks(marked, { done: { [key]: NOW }, snoozed: {} }, NOW)).toBe(marked)
})

test('R3: the pane draws every edge the page draws, in 1.15’s weights: spokes, dashed worktree and PR links, the lit edges of the selection at 2 in the accent (2.1.5)', () => {
  const snap = withGraph(normalizeSnapshot(buildSnapshot([session('local_pr', { worktreeId: 'c:\\repo\\app-wt', prs: [{ url: 'https://github.com/a/b/pull/7', number: 7, repo: 'a/b', branch: null, state: 'OPEN' }] }), session('local_two')]) as never), {}, { tier: 1 })
  const lookup = lookupOf(snap)
  const map = paneMap(snap.graph.nodes, snap.graph.edges, lookup, { stagePx: DOCK, camera: FIT, selected: 's:local_pr', now: NOW })
  const group = (attr: string) => new RegExp(`<g [^>]*${attr}[^>]*>(?:<line[^>]*/>)+</g>`).test(map.svg)
  expect(group('stroke-dasharray="3 4"')).toBe(true)
  expect(group(`stroke="${PALETTE.accent}" stroke-width="2"`)).toBe(true)
  const lines = (map.svg.match(/<line /g) ?? []).length
  const isOtherSessionToWorktree = (e: { from: string, to: string }) => e.from.startsWith('s:') && e.to.startsWith('w:') && e.from !== 's:local_pr'
  expect(snap.graph.edges.some(e => e.from === 's:local_pr' && e.to.startsWith('w:'))).toBe(true)
  expect(lines).toBe(snap.graph.edges.filter(e => e.kind !== 'lineage' && !isOtherSessionToWorktree(e)).length)
})

test('2.1.5: a session links to its worktree diamond only while it or the diamond is selected', () => {
  const snap = withGraph(normalizeSnapshot(buildSnapshot([session('local_wt', { worktreeId: 'c:\\repo\\app-wt' }), session('local_two')]) as never), {}, { tier: 1 })
  const lookup = lookupOf(snap)
  const linkCount = (selected: string | null) => paneMap(snap.graph.nodes, snap.graph.edges, lookup, { stagePx: DOCK, camera: FIT, selected, now: NOW }).svg.match(/<line /g)?.length ?? 0
  const sessionLinks = snap.graph.edges.filter(e => e.from.startsWith('s:') && e.to.startsWith('w:')).length
  expect(sessionLinks).toBe(2)
  expect(linkCount('s:local_wt')).toBe(linkCount(null) + 1)
  expect(linkCount('w:c:\\repo\\app-wt')).toBe(linkCount(null) + 1)
})

test('R3: in a dock the pane stacks the clusters to the dock’s shape, as 1.15 did, so Fit is larger; labels still never overlap', () => {
  const { view, lookup } = paneGraph(50, 10)
  const docked = paneMap(view.graph.nodes, view.graph.edges, lookup, { stagePx: DOCK, camera: FIT, selected: null, now: NOW, stack: true })
  const flat = paneMap(view.graph.nodes, view.graph.edges, lookup, { stagePx: DOCK, camera: FIT, selected: null, now: NOW })
  expect(docked.k).toBeGreaterThan(1.2 * flat.k)
  const boxes = [...docked.labels.values()].map(l => l.box)
  expect(countOverlaps(boxes)).toBe(0)
  expect(countOutside(boxes, { x: 0, y: 0, ...DOCK })).toBe(0)
  expect(docked.nodes.length).toBe(view.graph.nodes.length)
  const hub = docked.nodes.find(n => n.kind === 'project')!
  const before = view.graph.nodes.find(n => n.id === hub.id)!
  for (const n of docked.nodes.filter(x => x.parent === hub.id)) {
    const was = view.graph.nodes.find(x => x.id === n.id)!
    expect(Math.round(n.x - hub.x)).toBe(Math.round(was.x - before.x))
  }
})

test('2.1: the pane light rule covers every palette colour (the +N pill draws raised and controlEdge; B adds bg2, label, faint, grey)', () => {
  const { view, lookup } = paneGraph()
  const map = paneMap(view.graph.nodes, view.graph.edges, lookup, { stagePx: DOCK, camera: FIT, selected: null, now: NOW })
  const style = /<style>@media \(prefers-color-scheme: light\)\{(.*)\}<\/style>/.exec(map.svg)?.[1] ?? ''
  const palette = PALETTE as unknown as Record<string, string>
  const light = PALETTE_LIGHT as unknown as Record<string, string>
  for (const key of Object.keys(palette).filter(k => k !== 'onAccent' && typeof palette[k] === 'string')) {
    expect(style.includes(`[fill="${palette[key]}" i]{fill:${light[key]}}`) || palette[key]!.toLowerCase() === palette.bg!.toLowerCase()).toBe(true)
  }
})
