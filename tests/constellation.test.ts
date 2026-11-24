import { expect, test } from 'claude-code/testing'

import { layoutGraph } from '../shared/layout.js'
import { bucketColor, bucketOf, countOverlaps, fitMap, fitView, LABEL_PX, labelWidthPx, listedSessions, mapParts, needsYouText, placeLabels, shortTitle, tierFor } from '../shared/map.js'
import { PALETTE, PALETTE_LIGHT } from '../shared/constants.js'
import { lookupOf } from '../shared/render.js'
import { synthetic } from './fixtures'

const STAGE = { w: 1160, h: 856 }

const sessionsOf = (n: number) => synthetic(12, n, 3)

test('C2: sessions of one project sit at least 40 units apart, and project clusters never overlap', () => {
  const graph = layoutGraph(sessionsOf(300), {})
  const sessions = graph.nodes.filter(n => n.kind === 'session')
  const byProject = new Map<string, typeof sessions>()
  for (const s of sessions) byProject.set(s.parent ?? '', [...(byProject.get(s.parent ?? '') ?? []), s])
  for (const list of byProject.values()) {
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) expect(Math.hypot(list[i]!.x - list[j]!.x, list[i]!.y - list[j]!.y)).toBeGreaterThanOrEqual(40)
  }
  const discs = graph.nodes.filter(n => n.kind === 'project').map(p => {
    const members = sessions.filter(s => s.parent === p.id)
    return { x: p.x, y: p.y, r: Math.max(...members.map(s => Math.hypot(s.x - p.x, s.y - p.y))) + 20 }
  })
  for (let i = 0; i < discs.length; i += 1) for (let j = i + 1; j < discs.length; j += 1) expect(Math.hypot(discs[i]!.x - discs[j]!.x, discs[i]!.y - discs[j]!.y)).toBeGreaterThan(discs[i]!.r + discs[j]!.r)
})

test('C2: at 300 sessions the laid-out map is compact enough that Fit gives sessions at least 4 px apart on a 1440 px window', () => {
  const graph = layoutGraph(sessionsOf(300), {})
  const camera = fitView(graph.nodes, STAGE, 32)
  expect((STAGE.w / camera.w) * 40).toBeGreaterThanOrEqual(4)
})

test('C2: Fit keeps every node and a margin inside the stage, at the stage’s aspect', () => {
  for (const n of [10, 50, 300]) {
    const graph = layoutGraph(sessionsOf(n), {})
    for (const stage of [STAGE, { w: 860, h: 716 }, { w: 620, h: 656 }]) {
      const c = fitView(graph.nodes, stage, 32)
      expect(Math.abs(c.w / c.h - stage.w / stage.h)).toBeLessThan(0.001)
      const k = stage.w / c.w
      for (const node of graph.nodes) {
        expect((node.x - node.r - c.x) * k).toBeGreaterThanOrEqual(31.9)
        expect((c.x + c.w - node.x - node.r) * k).toBeGreaterThanOrEqual(31.9)
        expect((node.y - node.r - c.y) * k).toBeGreaterThanOrEqual(31.9)
        expect((c.y + c.h - node.y - node.r) * k).toBeGreaterThanOrEqual(31.9)
      }
    }
  }
})

const candidate = (id: string, x: number, y: number, priority: number, text = 'A session title') => ({ id, x, y, r: 8, text, priority })

test('C2: label placement never overlaps, never leaves the stage, and drops the lower priority label rather than shrink it', () => {
  const view = { x: 0, y: 0, w: 400, h: 300 }
  const placed = placeLabels([candidate('a', 100, 100, 1), candidate('b', 104, 102, 5), candidate('c', 395, 150, 1)], view, 1, [])
  expect(placed.has('b')).toBe(true)
  const boxes = [...placed.values()].map(p => p.box)
  expect(countOverlaps(boxes)).toBe(0)
  for (const b of boxes) expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= 400 && b.y + b.h <= 300).toBe(true)
  expect(placed.get('c')?.anchor).toBe('end')
})

test('C2: a label keeps clear of other session dots', () => {
  const view = { x: 0, y: 0, w: 400, h: 300 }
  const placed = placeLabels([candidate('a', 100, 100, 1)], view, 1, [{ x: 130, y: 100, r: 8 }])
  const box = placed.get('a')!.box
  expect(box.x > 138 || box.x + box.w < 122 || box.y > 108 || box.y + box.h < 92).toBe(true)
})

test('C2: labels are 13 px on screen (DESIGN.md body size) whatever the zoom, and their width is estimated from the text', () => {
  expect(LABEL_PX).toBe(13)
  expect(labelWidthPx('abcdefghij')).toBeGreaterThan(labelWidthPx('abc'))
})

test('C2: the zoom tier comes from on-screen size: overview, sessions, detail', () => {
  expect(tierFor(0.2)).toBe(0)
  expect(tierFor(0.6)).toBe(1)
  expect(tierFor(1.2)).toBe(2)
})

test('C2: a needs-you label with no room for its whole title is shortened from the middle, still at 13 px; any other label is dropped', () => {
  const view = { x: 0, y: 0, w: 150, h: 60 }
  const long = 'A long session title that needs room'
  const placed = placeLabels([{ ...candidate('must', 10, 30, 5, long), isMust: true }, { ...candidate('other', 10, 50, 1, long) }], view, 1, [])
  expect(placed.get('must')?.text).toBe('A long…room')
  expect(placed.has('other')).toBe(false)
})

const burst = () => {
  const base = sessionsOf(300)
  const sessions = base.sessions.map(s => (s.projectId.endsWith('project-0') ? { ...s, attention: 'question' as const, lifecycle: 'waiting-user' as const } : { ...s, attention: null, lifecycle: s.lifecycle === 'waiting-user' ? ('idle' as const) : s.lifecycle }))
  return { ...base, sessions }
}

test('C2 review #5: labels keep their spot across an update while it is still free', () => {
  const snapshot = sessionsOf(50)
  const graph = layoutGraph(snapshot, {})
  const camera = fitMap(graph.nodes, STAGE, 32)
  const first = mapParts(graph.nodes, graph.edges, lookupOf({ ...snapshot, graph } as never), { camera, stagePx: STAGE, selected: null })
  const target = snapshot.sessions.find(s => s.lifecycle === 'idle')!
  const changed = { ...snapshot, sessions: snapshot.sessions.map(s => (s.key === target.key ? { ...s, lifecycle: 'running' as const } : s)) }
  const second = mapParts(graph.nodes, graph.edges, lookupOf({ ...changed, graph } as never), { camera, stagePx: STAGE, selected: null, previous: first.placement })
  const moved = [...second.placement].filter(([id, spot]) => first.placement.has(id) && first.placement.get(id) !== spot).length
  expect(moved).toBeLessThanOrEqual(2)
})

test('C2 review #6: labels stay off reserved boxes (the camera controls), and Fit can keep a corner clear', () => {
  const view = { x: 0, y: 0, w: 400, h: 300 }
  const placed = placeLabels([candidate('a', 200, 150, 1)], view, 1, [], { reserved: [{ x: 208, y: 130, w: 150, h: 40 }] })
  const box = placed.get('a')!.box
  expect(box.x + box.w <= 208 || box.y + box.h <= 130 || box.y >= 170 || box.x >= 358).toBe(true)
  const graph = layoutGraph(sessionsOf(50), {})
  const c = fitView(graph.nodes, STAGE, { top: 32, right: 32, bottom: 88, left: 32 })
  const k = STAGE.w / c.w
  for (const n of graph.nodes) expect((c.y + c.h - n.y - n.r) * k).toBeGreaterThanOrEqual(87.9)
})

test('C2 re-review: a shortened title keeps its last word when it is short, and cluster names make way for needs-you labels from the sessions tier on', () => {
  expect(shortTitle('docs-site (terminal)')).toBe('docs-site…(terminal)')
  expect(shortTitle('A very long session title about billing exports')).toBe('A very…exports')
  expect(shortTitle('Session 116 running the billing export')).toBe('Session…export')
  expect(shortTitle('Session 116')).toBe('Session 116')
  expect(shortTitle('Supercalifragilistic expialidocious')).toBe('Supercali…cious')
  expect(shortTitle('Fix the queue 2026-11-13T10:42')).toBe('Fix the…10:42')
  const snapshot = sessionsOf(50)
  const graph = layoutGraph(snapshot, {})
  const camera = fitMap(graph.nodes, STAGE, 32)
  const k = STAGE.w / camera.w
  const parts = mapParts(graph.nodes, graph.edges, lookupOf({ ...snapshot, graph } as never), { camera, stagePx: STAGE, selected: null })
  if (tierFor(k) > 0) expect(parts.unlabelledNeedsYou).toBe(0)
  for (const part of parts.nodes.filter(p => p.id.endsWith('#name'))) expect(part.markup.includes('<line')).toBe(false)
})

test('C6 pane follow-ups: the map draws with a given palette, exports its bucket colours, and words needs-you counts one way', () => {
  const snapshot = sessionsOf(20)
  const graph = layoutGraph(snapshot, {})
  const camera = fitMap(graph.nodes, STAGE, 32)
  const light = mapParts(graph.nodes, graph.edges, lookupOf({ ...snapshot, graph } as never), { camera, stagePx: STAGE, selected: null, palette: PALETTE_LIGHT })
  const markup = light.nodes.map(p => p.markup).join('')
  expect(markup.includes(PALETTE_LIGHT.text)).toBe(true)
  expect(markup.includes(PALETTE.text)).toBe(false)
  expect(bucketColor('needs-you', PALETTE_LIGHT)).toBe(PALETTE_LIGHT.amber)
  expect(bucketColor('idle', PALETTE)).toBe(PALETTE.dim)
  expect(needsYouText(1)).toBe('1 needs you')
  expect(needsYouText(3)).toBe('3 need you')
})

test('C6 pane follow-ups: one shared list of the sessions a view shows, without repeats', () => {
  const a = { key: 'a' }
  const b = { key: 'b' }
  expect(listedSessions({ attention: [a], pinned: [a, b], sessions: [b] } as never).map(s => s.key)).toEqual(['a', 'b'])
  expect(listedSessions(null)).toEqual([])
})

test('Pin: a pinned session carries a shape mark on the map (a text-coloured diamond), never a colour change; others do not', () => {
  const snapshot = sessionsOf(20)
  const graph = layoutGraph(snapshot, {})
  const camera = fitMap(graph.nodes, STAGE, 32)
  const key = snapshot.sessions[3]?.key ?? ''
  const parts = mapParts(graph.nodes, graph.edges, lookupOf({ ...snapshot, graph } as never), { camera, stagePx: STAGE, selected: null, pinned: new Set([key]) })
  const pinned = parts.nodes.find(p => p.id === `s:${key}`)
  expect(pinned?.markup.includes(`class="pin" `)).toBe(true)
  expect(pinned?.markup.includes(`fill="${PALETTE.text}"`)).toBe(true)
  expect(parts.nodes.filter(p => p.markup.includes('class="pin"')).length).toBe(1)
})

test('a label left of its node ends exactly at its spot (its leader\'s end), whatever the text\'s real width; only the icon is fitted to the drawn text', () => {
  const snapshot = sessionsOf(50)
  const graph = layoutGraph(snapshot, {})
  const camera = fitMap(graph.nodes, STAGE, 32)
  const parts = mapParts(graph.nodes, graph.edges, lookupOf({ ...snapshot, graph } as never), { camera, stagePx: STAGE, selected: null })
  const left = [...parts.labels].filter(([, at]) => at.anchor === 'end' && at.icon)
  expect(left.length).toBeGreaterThan(0)
  for (const [id, at] of left) {
    const n = graph.nodes.find(node => node.id === id)!
    const markup = parts.nodes.find(p => p.id === id)!.markup
    const x = String(Math.round((at.x - n.x) * 100) / 100)
    expect(markup).toMatch(new RegExp(`<text x="${x}" y="[^"]+" font-size="[^"]+" text-anchor="end"`))
    expect(markup).toContain('data-fit="end"')
  }
})

test('a session robot on the map draws in its chosen colour, and in the accent without one', () => {
  const snapshot = sessionsOf(3)
  const tinted = { ...snapshot, sessions: snapshot.sessions.map(s => ({ ...s, tint: 'pink' as const })) }
  const graph = layoutGraph(tinted, {})
  const camera = fitMap(graph.nodes, STAGE, 32)
  const parts = (snap: typeof snapshot, palette: typeof PALETTE) => mapParts(graph.nodes, graph.edges, lookupOf({ ...snap, graph } as never), { camera, stagePx: STAGE, selected: null, palette }).nodes.map(p => p.markup).join('')
  expect(parts(tinted, PALETTE)).toContain(`stroke="${PALETTE.tintPink}"`)
  expect(parts(tinted, PALETTE_LIGHT)).toContain(`stroke="${PALETTE_LIGHT.tintPink}"`)
  expect(parts(snapshot, PALETTE)).not.toContain(PALETTE.tintPink)
})
