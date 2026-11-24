import { countOutside, countOverlaps } from '/shared/map.js'
import { $, applyPhases, state, view, visibleSessions } from './page-state.js'
import { frames } from './stage.js'

export function metrics() {
  const stage = $('cx-stage')
  const box = stage.getBoundingClientRect()
  const stageBoxPx = { x: box.left, y: box.top, w: box.width, h: box.height }
  const toBox = r => ({ x: r.left, y: r.top, w: r.width, h: r.height })
  const texts = [...stage.querySelectorAll('svg text')].filter(t => t.getBoundingClientRect().width > 0)
  const labelPx = texts.map(t => (t.getScreenCTM()?.a ?? 1) * parseFloat(t.getAttribute('font-size') ?? getComputedStyle(t).fontSize))
  const labelBoxes = texts.map(t => toBox(t.getBoundingClientRect()))
  const nodeBoxes = [...stage.querySelectorAll('svg g.n')].map(g => toBox(g.getBoundingClientRect()))
  const sorted = [...frames.times].sort((a, b) => a - b)
  return {
    sessions: visibleSessions().length,
    nodes: nodeBoxes.length,
    labels: texts.length,
    minLabelPx: labelPx.length ? Math.round(Math.min(...labelPx) * 10) / 10 : null,
    collisions: countOverlaps(labelBoxes),
    ...labelPlacementChecks(stage),
    unlabelledNeedsYou: state.unlabelledNeedsYou ?? null,
    offStage: countOutside(nodeBoxes, stageBoxPx),
    lastTouched: view.stats.touched,
    lastUpdateMs: Math.round(view.stats.ms * 10) / 10,
    lastApplyMs: state.lastApplyMs === undefined ? null : Math.round(state.lastApplyMs * 10) / 10,
    applyPhases: { ...applyPhases },
    updates: view.stats.updates,
    frameP95Ms: sorted.length ? Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10 : null,
    frames: sorted.length,
  }
}

function labelPlacementChecks(stage) {
  const centre = r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 })
  const sessions = [...stage.querySelectorAll('svg g.k-session')]
  const dots = sessions.map(g => ({ id: g.dataset.id, ...centre(g.querySelector('circle:last-of-type').getBoundingClientRect()) }))
  const rings = [...stage.querySelectorAll('svg g.k-project')].map(g => ({ id: g.dataset.id, ...centre(g.querySelector('circle').getBoundingClientRect()) }))
  const meets = (b, c) => Math.hypot(Math.max(b.left, Math.min(c.x, b.right)) - c.x, Math.max(b.top, Math.min(c.y, b.bottom)) - c.y) < c.r
  let onDots = 0
  let outside = 0
  for (const g of sessions) {
    const text = g.querySelector('text')
    if (!text) continue
    const b = text.getBoundingClientRect()
    if (dots.some(d => d.id !== g.dataset.id && meets(b, d))) onDots += 1
    if (rings.some(c => c.id !== g.dataset.parent && meets(b, c))) outside += 1
  }
  return { labelsOnOtherDots: onDots, labelsInOtherClusters: outside }
}

export function bench(count = 60) {
  const start = state.camera
  const probe = $('cx-stage').querySelector('svg g.n')
  if (!start || !probe) return null
  const times = []
  for (let i = 0; i < count; i += 1) {
    const t0 = performance.now()
    view.preview({ ...start, x: start.x + (i % 10) * start.w * 0.01, y: start.y + Math.floor(i / 10) * start.h * 0.01 })
    probe.getBoundingClientRect()
    times.push(performance.now() - t0)
  }
  view.setViewBox(start)
  times.sort((a, b) => a - b)
  return { moves: count, p50Ms: Math.round(times[Math.floor(count / 2)] * 100) / 100, p95Ms: Math.round(times[Math.floor(count * 0.95)] * 100) / 100 }
}
