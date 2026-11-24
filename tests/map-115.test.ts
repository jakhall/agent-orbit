import { expect, test } from 'claude-code/testing'

import type { SessionView } from '../types'
import { PALETTE } from '../shared/constants.js'
import { normalizeSnapshot } from '../shared/filters.js'
import { countOutside, countOverlaps, fitMap, KIND_ICONS, mapParts } from '../shared/map.js'
import { lookupOf } from '../shared/render.js'
import { agent, bucketed, buildSnapshot, NOW, session } from './fixtures'

const STAGES = [
  { w: 1160, h: 856 },
  { w: 860, h: 716 },
  { w: 560, h: 656 },
]

function drawn(snapshot: ReturnType<typeof buildSnapshot>, stage = STAGES[0]!, more: Record<string, unknown> = {}) {
  const graph = snapshot.graph
  const camera = fitMap(graph.nodes, stage, 32)
  const parts = mapParts(graph.nodes, graph.edges, lookupOf(snapshot as never), { camera, stagePx: stage, selected: null, now: NOW, ...more })
  return { graph, camera, parts, k: stage.w / camera.w, markup: (id: string) => parts.nodes.find(p => p.id === id)?.markup ?? '' }
}

const status = (bucket: string, reason: string) => ({ status: { bucket, reason, since: NOW - 60_000, isObserved: true } }) as Partial<SessionView>

function small() {
  const p = { projectId: 'c:\\repo\\app', worktreeId: 'c:\\repo\\app' }
  return normalizeSnapshot(
    buildSnapshot(
      [
        session('local_need', { ...p, title: 'Fix the login bug', lifecycle: 'waiting-user', attention: 'question', ...status('needs-you', 'Asked you a question') }),
        session('local_run', { ...p, title: 'Refactor the parser', lifecycle: 'running', ...status('working', 'Editing parser.ts') }),
        session('local_fail', { ...p, title: 'Release build', lifecycle: 'failed', ...status('failed', 'Failed: tool error') }),
        session('local_done', { ...p, title: 'Write docs', ...status('review', 'Finished, not opened since') }),
        session('local_idle', { ...p, title: 'Old spike', ...status('idle', 'Idle') }),
      ],
      [agent('local_run', 'a1', { description: 'Search the codebase', lifecycle: 'running' })],
    ) as never,
  ) as unknown as ReturnType<typeof buildSnapshot>
}

test('R2: a project is a hexagon hub with its session count inside and its name with "N sessions · M running" under it; no ring around it', () => {
  const { markup, parts } = drawn(small())
  const hub = markup('p:c:\\repo\\app')
  expect(hub).toContain('<polygon')
  expect(hub).toMatch(/<text[^>]*font-weight="700"[^>]*>5<\/text>/)
  expect(hub).toContain('>app<')
  expect(hub).toContain('5 sessions · 1 running · 1 needs you')
  expect(hub).not.toMatch(/<circle[^>]*fill="none"/)
  expect(parts.nodes.some(p => p.id.endsWith('#name'))).toBe(false)
})

test('R2: a session is a ringed circle with a status dot in its bucket colour, a plain orange dot (no second ring, no edge) when it needs you, and a bold title with no status sub-line (2.2.12: the status is in its tooltip)', () => {
  const { markup } = drawn(small())
  const need = markup('s:local_need')
  expect(need).not.toMatch(/<circle r="[\d.]+" fill="none"/)
  expect(need).toMatch(/<circle r="4" fill="#[0-9A-F]{6}">/i)
  expect(need).toMatch(/font-weight="600"[^>]*>Fix the login bug</)
  expect(need).not.toContain('>Needs you · Asked you a question<')
  expect(need).toContain('Asked you a question')
  const dot = (id: string) => /<circle r="4" fill="(#[0-9A-Fa-f]{6})"/.exec(markup(id))?.[1] ?? null
  expect([dot('s:local_need'), dot('s:local_run'), dot('s:local_fail'), dot('s:local_done'), dot('s:local_idle')]).toEqual(['#FF7A1F', '#6C93E8', '#E06464', '#2FD58F', null])
  expect(markup('s:local_run')).not.toMatch(/<text[^>]*>Working/)
})

test('R2: spokes join each hub to its sessions, satellites and their links show at every zoom, and a worktree or PR hangs off on a dashed link', () => {
  const snap = small()
  const far = drawn(snap, { w: 300, h: 220 })
  expect(far.parts.edges.filter(e => e.group === 'hierarchy' && e.id.startsWith('hierarchy:p:')).length).toBe(5)
  expect(far.parts.nodes.some(p => p.id.startsWith('a:'))).toBe(true)
  expect(far.parts.edges.some(e => e.id === 'hierarchy:s:local_run>a:local_run/a1')).toBe(true)
  const withPr = normalizeSnapshot(buildSnapshot([session('local_pr', { prs: [{ url: 'https://github.com/a/b/pull/7', number: 7, repo: 'a/b', branch: null, state: 'OPEN' }] })]) as never) as unknown as ReturnType<typeof buildSnapshot>
  const pr = drawn(withPr)
  expect(pr.markup('pr:local_pr#7')).toMatch(/<rect x="-6" y="-6" width="12" height="12" rx="3"/)
  expect(pr.parts.edges.some(e => e.group === 'resource' && e.id === 'resource:s:local_pr>pr:local_pr#7')).toBe(true)
})

test('R2: no two labels overlap or leave the stage, and every title is at least 10 px, at 10, 50 and 300 sessions on three widths', () => {
  for (const [count, projects] of [
    [10, 3],
    [50, 10],
    [300, 12],
  ] as const) {
    const snap = normalizeSnapshot(bucketed(count, projects) as never) as unknown as ReturnType<typeof buildSnapshot>
    for (const stage of STAGES) {
      const { parts, k } = drawn(snap, stage)
      const boxes = [...parts.labels.values()].map(l => l.box)
      expect(boxes.length).toBeGreaterThan(0)
      expect(countOverlaps(boxes)).toBe(0)
      expect(countOutside(boxes, { x: 0, y: 0, ...stage })).toBe(0)
      for (const l of parts.labels.values()) expect((l.px ?? 13) >= 9.9 || l.kind !== 'title').toBe(true)
      expect(k).toBeGreaterThan(0)
    }
  }
})

const outlinedBy = (color: string) => new RegExp(`<(circle|polygon) [^>]*stroke="${color}"`)

test('2.1.7 focus: the selected session’s own outline and its project hexagon turn accent with no extra ring, only its own links are lit, everything else fades to .32; keyboard focus adds nothing', () => {
  const snap = small()
  const plain = drawn(snap)
  const picked = drawn(snap, STAGES[0], { selected: 's:local_run' })
  expect(picked.markup('s:local_run')).toContain(`stroke="${PALETTE.accent}" stroke-width="2.5"`)
  expect(picked.markup('s:local_run').match(/<circle /g)?.length).toBe(plain.markup('s:local_run').match(/<circle /g)?.length)
  const hub = picked.parts.nodes.find(n => n.id.startsWith('p:') && picked.markup('s:local_run').includes(`data-parent="${n.id}"`))
  expect(hub?.markup).toContain(`<polygon points="`)
  expect(hub?.markup).toMatch(new RegExp(`<polygon [^>]*stroke="${PALETTE.accent}" stroke-width="2"`))
  for (const other of picked.parts.nodes.filter(n => n.id.startsWith('p:') && n.id !== hub?.id)) expect(other.markup).not.toMatch(outlinedBy(PALETTE.accent))
  expect(picked.markup('s:local_run')).not.toContain('<g opacity=')
  const lit = picked.parts.edges.filter(e => e.group === 'lit')
  expect(lit.length).toBeGreaterThan(0)
  for (const e of lit) expect(e.id).toContain('s:local_run')
  expect(picked.markup('s:local_need')).toMatch(/<g opacity="0.32">/)
  expect(picked.markup('s:local_idle')).toMatch(/<g opacity="0.32">/)
  const focused = drawn(snap, STAGES[0], { focused: 's:local_idle' })
  expect(focused.markup('s:local_idle')).toBe(plain.markup('s:local_idle'))
})

test('2.1.8 project focus: a selected project keeps everything under it full and lights every link inside it; other projects fade', () => {
  const p = { projectId: 'c:\\repo\\app', worktreeId: 'c:\\repo\\app' }
  const q = { projectId: 'c:\\repo\\other', worktreeId: 'c:\\repo\\other' }
  const snap = normalizeSnapshot(
    buildSnapshot(
      [
        session('local_run', { ...p, title: 'Refactor the parser', lifecycle: 'running', ...status('working', 'Editing parser.ts') }),
        session('local_idle', { ...p, title: 'Old spike', ...status('idle', 'Idle') }),
        session('local_far', { ...q, title: 'Elsewhere', lifecycle: 'running', ...status('working', 'Reading') }),
      ],
      [agent('local_run', 'a1', { description: 'Search the codebase', lifecycle: 'running' })],
    ) as never,
  ) as unknown as ReturnType<typeof buildSnapshot>
  const hub = snap.graph.nodes.find(n => n.id.startsWith('p:') && n.id.includes('app'))!.id
  const picked = drawn(snap, STAGES[0], { selected: hub })
  expect(picked.markup(hub)).toMatch(new RegExp(`<polygon [^>]*stroke="${PALETTE.accent}" stroke-width="2"`))
  for (const id of ['s:local_run', 's:local_idle', 'a:local_run/a1']) expect(picked.markup(id)).not.toContain('<g opacity=')
  expect(picked.markup('s:local_far')).toMatch(/<g opacity="0.32">/)
  const inside = picked.parts.edges.filter(e => e.id.includes(hub) || e.id.includes('a:local_run/a1'))
  expect(inside.length).toBeGreaterThan(2)
  for (const e of inside) expect(e.group).toBe('lit')
  for (const e of picked.parts.edges.filter(e => e.id.includes('local_far'))) expect(e.group).not.toBe('lit')
  for (const s of ['s:local_run', 's:local_idle', 'a:local_run/a1']) expect(picked.markup(s)).toMatch(outlinedBy(PALETTE.accent))
  expect(picked.markup('s:local_far')).not.toMatch(outlinedBy(PALETTE.accent))
})

test('2.1.5 focus: with nothing selected, idle sessions and their links fade to .5; pinned or matched idle ones, and busy ones, stay full', () => {
  const snap = small()
  const plain = drawn(snap)
  expect(plain.markup('s:local_idle')).toMatch(new RegExp(`<circle r="[\\d.]+" fill="${PALETTE.bg}" stroke="${PALETTE.bg}" [^>]*/><g opacity="0.5">`))
  expect(plain.markup('s:local_run')).not.toContain('<g opacity=')
  expect(plain.markup('s:local_need')).not.toContain('<g opacity=')
  for (const e of plain.parts.edges) expect(e.markup.includes('opacity="0.5"')).toBe(e.id.includes('s:local_idle'))
  expect(drawn(snap, STAGES[0], { pinned: new Set(['local_idle']) }).markup('s:local_idle')).not.toContain('<g opacity=')
  expect(drawn(snap, STAGES[0], { matches: new Set(['s:local_idle']) }).markup('s:local_idle')).not.toContain('<g opacity=')
})

function satellites() {
  const p = { projectId: 'c:\\repo\\app', worktreeId: 'c:\\repo\\app' }
  return normalizeSnapshot(
    buildSnapshot(
      [
        session('local_cve', { ...p, title: 'Linux OS CVEs', lifecycle: 'failed', ...status('failed', 'Failed: tool error') }),
        session('local_stale', { ...p, title: 'Stale worker', lifecycle: 'stale', ...status('working', 'Editing a.ts') }),
        session('local_wt', { projectId: 'c:\\repo\\app', worktreeId: 'c:\\repo\\app-wt', title: 'In a worktree', ...status('idle', 'Idle') }),
      ],
      [1, 2, 3, 4, 5, 6].map(i => agent('local_cve', `a${i}`, { description: `Check ${i}`, lifecycle: i % 2 ? 'completed' : 'running' })),
    ) as never,
  ) as unknown as ReturnType<typeof buildSnapshot>
}

test('2.1.5 focus: with a selection, edges outside it fade to .28; lit edges stay full', () => {
  const picked = drawn(small(), STAGES[0], { selected: 's:local_run' })
  const quiet = picked.parts.edges.filter(e => e.group === 'hierarchy' || e.group === 'resource')
  expect(quiet.length).toBeGreaterThan(0)
  for (const e of quiet) expect(e.markup).toContain('opacity="0.28"')
  for (const e of picked.parts.edges.filter(e => e.group === 'lit')) expect(e.markup).not.toContain('opacity')
})

test('2.1 review: a completed sub-agent keeps 1.15.2’s green dot; a stale session shows no working dot', () => {
  const { parts, markup } = drawn(satellites())
  const done = parts.nodes.find(n => n.id.endsWith('/a1'))!.markup
  expect(done).toMatch(/<circle r="2.4" fill="#2FD58F"/i)
  expect(markup('s:local_stale')).toContain('stroke-dasharray="3 3"')
  expect(markup('s:local_stale')).not.toMatch(/<circle r="4" fill=/)
})

test('2.1 review: a worktree is named whenever the map is not at its low-detail zoom, as in 1.15.2', () => {
  const snap = satellites()
  const graph = snap.graph
  const wt = graph.nodes.find(n => n.kind === 'worktree')!
  expect(wt).toBeDefined()
  const fit = fitMap(graph.nodes, STAGES[0]!, 32)
  const camera = { ...fit, w: STAGES[0]!.w / 0.7, h: STAGES[0]!.h / 0.7, x: wt.x - STAGES[0]!.w / 1.4, y: wt.y - STAGES[0]!.h / 1.4 }
  const parts = mapParts(graph.nodes, graph.edges, lookupOf(snap as never), { camera, stagePx: STAGES[0]!, selected: null, now: NOW })
  expect(parts.labels.has(wt.id)).toBe(true)
})

test('2.1 review: a session title starts 9 world units past its ring, as in 1.15.2, and keeps its spot when the session is selected', () => {
  const snap = small()
  const stage = STAGES[0]!
  const run = snap.graph.nodes.find(n => n.id === 's:local_run')!
  const camera = { x: run.x - stage.w / 2, y: run.y - stage.h / 2, w: stage.w, h: stage.h }
  const at = (selected: string | null) => mapParts(snap.graph.nodes, snap.graph.edges, lookupOf(snap as never), { camera, stagePx: stage, selected, now: NOW }).labels.get('s:local_run')!
  const plain = at(null)
  expect(Math.round(Math.abs(plain.x - run.x) * 100) / 100).toBe(run.r + 9)
  const sats = satellites()
  const cve = sats.graph.nodes.find(n => n.id === 's:local_cve')!
  const near = { x: cve.x - stage.w / 2, y: cve.y - stage.h / 2, w: stage.w, h: stage.h }
  const spot = (selected: string | null) => mapParts(sats.graph.nodes, sats.graph.edges, lookupOf(sats as never), { camera: near, stagePx: stage, selected, now: NOW }).labels.get('s:local_cve')!
  expect(spot('s:local_cve').spot).toBe(spot(null).spot)
  expect(spot('s:local_cve').leader).toBe(false)
  expect(spot(null).leader).toBe(false)
})

test('2.1.5: Map animation brings back 1.15 pulses: Off draws none, Low pulses the needs-you ring, Normal also the working dot', () => {
  const snap = small()
  const pulses = (animation: string | undefined, id: string) => (drawn(snap, STAGES[0]!, animation ? { animation } : {}).markup(id).match(/<animate /g) ?? []).length
  for (const off of [undefined, 'off']) {
    expect(pulses(off, 's:local_need')).toBe(0)
    expect(pulses(off, 's:local_run')).toBe(0)
  }
  expect(pulses('low', 's:local_need')).toBe(2)
  expect(pulses('low', 's:local_run')).toBe(0)
  expect(pulses('normal', 's:local_need')).toBe(2)
  expect(pulses('normal', 's:local_run')).toBe(1)
  expect(drawn(snap, STAGES[0]!, { animation: 'normal' }).markup('s:local_need')).toContain('repeatCount="indefinite"')
})

test('2.2.3: the working dot fades deep and fast enough to see at a glance', () => {
  expect(drawn(small(), STAGES[0]!, { animation: 'normal' }).markup('s:local_run')).toContain('values=".15;1;.15" dur="1.6s"')
})

test('2.2.11: a session that needs you sends a sonar ping every 2 s and has one ring like the rest; its dot has no edge (2.2.18); Off draws no ping', () => {
  const need = (animation: string) => drawn(small(), STAGES[0]!, { animation }).markup('s:local_need')
  const ping = need('low').match(/<circle class="sonar" r="([\d.]+)"[^>]*pointer-events="none"><animate attributeName="r" values="([\d.]+);([\d.]+)"[^>]*dur="2s"[^>]*\/><animate attributeName="stroke-opacity" values=".9;0"/)
  expect(ping).not.toBeNull()
  expect(Number(ping![3]) - Number(ping![2])).toBe(22)
  for (const animation of ['low', 'off']) {
    expect(need(animation)).not.toMatch(/<circle r="[\d.]+" fill="none"/)
    expect(need(animation)).toMatch(/<circle r="4" fill="[^"]+">/)
  }
  expect(need('off')).not.toContain('sonar')
})

test('2.2.12: each label starts with a blue kind icon: a robot for a session, a fork for a forked one, a folder for a project, an arrow for a sub-agent, a branch for a worktree', () => {
  const p = { projectId: 'c:\\repo\\app', worktreeId: 'c:\\repo\\app' }
  const snap = normalizeSnapshot(
    buildSnapshot(
      [
        session('local_run', { ...p, title: 'Refactor the parser', lifecycle: 'running', ...status('working', 'Editing parser.ts') }),
        session('local_fork', { ...p, title: 'Try another parser', parent: { key: 'local_run', kind: 'fork' }, ...status('review', 'Finished') }),
      ],
      [agent('local_run', 'a1', { description: 'Search the codebase', lifecycle: 'running' })],
    ) as never,
  ) as unknown as ReturnType<typeof buildSnapshot>
  const glyph = (name: keyof typeof KIND_ICONS) => `<g stroke="${PALETTE.accent}" stroke-width="1.6">${KIND_ICONS[name]}</g></g><text`
  const picked = drawn(snap, STAGES[0], { selected: 's:local_run' })
  const hub = snap.graph.nodes.find(n => n.kind === 'project')!.id
  expect(picked.markup('s:local_run')).toContain(glyph('session'))
  expect(picked.markup('s:local_fork')).toContain(glyph('fork'))
  expect(picked.markup(hub)).toContain(glyph('project'))
  expect(picked.markup('a:local_run/a1')).toContain(glyph('agent'))
  expect(countOverlaps([...picked.parts.labels.values()].map(l => l.box))).toBe(0)
  const wtSnap = satellites()
  const wt = wtSnap.graph.nodes.find(n => n.kind === 'worktree')!
  const fit = fitMap(wtSnap.graph.nodes, STAGES[0]!, 32)
  const camera = { ...fit, w: STAGES[0]!.w / 0.7, h: STAGES[0]!.h / 0.7, x: wt.x - STAGES[0]!.w / 1.4, y: wt.y - STAGES[0]!.h / 1.4 }
  const parts = mapParts(wtSnap.graph.nodes, wtSnap.graph.edges, lookupOf(wtSnap as never), { camera, stagePx: STAGES[0]!, selected: null, now: NOW })
  expect(parts.nodes.find(n => n.id === wt.id)?.markup).toContain(glyph('branch'))
})
