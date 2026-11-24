import type { Camera, GraphEdge, GraphNode, SessionView } from '../../types'
import { PALETTE, PALETTE_LIGHT } from '../../shared/constants.js'
import { fitMap, labelScaleAt, mapParts, tierFor } from '../../shared/map.js'
import { stackClusters } from '../../shared/render.js'

/** A world rectangle on screen. */
export type Rect = { x: number; y: number; w: number; h: number }

type Lookup = { sessions: Map<string, SessionView>; projects: Map<string, { name: string }> }
type Parts = ReturnType<typeof mapParts>

export type PaneMap = {
  svg: string
  /** The camera at zoom 1: what Fit shows. */
  fit: Rect
  /** The camera drawn. */
  view: Rect
  /** Screen px per world unit. */
  k: number
  tier: 0 | 1 | 2
  /** The nodes as drawn (stacked in a dock). */
  nodes: GraphNode[]
  labels: Parts['labels']
  unlabelledNeedsYou: number
}

/** Every palette colour, one key per dark value (the first wins); `onAccent` is left out, since its dark value is also `bg`'s. */
const DRAWN_COLORS = (Object.keys(PALETTE) as (keyof typeof PALETTE)[]).filter(
  (key, i, keys) => key !== 'onAccent' && typeof PALETTE[key] === 'string' && keys.findIndex(other => String(PALETTE[other]).toLowerCase() === String(PALETTE[key]).toLowerCase()) === i,
)

/**
 * The kit gives a render hook no host theme, so the map carries its light
 * twin: under `prefers-color-scheme: light` every dark colour it draws
 * becomes its `PALETTE_LIGHT` value (CSS outranks presentation attributes).
 */
const LIGHT_STYLE = `<style>@media (prefers-color-scheme: light){${DRAWN_COLORS.flatMap(key => ['fill', 'stroke'].map(attr => `[${attr}="${PALETTE[key]}" i]{${attr}:${PALETTE_LIGHT[key]}}`)).join('')}}</style>`

/** Room for a cluster's name above its ring at the top; the rest a small margin. */
const PANE_PAD = { top: 24, right: 12, bottom: 12, left: 12 }

const r2 = (n: number) => String(Math.round(n * 100) / 100)

/**
 * The pane's constellation on the shared layout, drawn by the page's own map
 * parts (`mapParts`): the tier from the zoom, labels at 13 px placed without
 * overlap, cluster names with their need counts. `framed` (a focused
 * project) sets Fit; every node is drawn.
 */
export function paneMap(
  nodes: GraphNode[],
  edges: GraphEdge[],
  lookup: Lookup,
  options: { stagePx: { w: number; h: number }; camera: Camera; selected: string | null; now: number; pinned?: ReadonlySet<string>; overflow?: Record<string, { count: number; noun: string; reason?: string }>; framed?: GraphNode[]; stack?: boolean },
): PaneMap {
  const stagePx = { w: Math.max(1, Math.round(options.stagePx.w)), h: Math.max(1, Math.round(options.stagePx.h)) }
  const framedIds = options.framed ? new Set(options.framed.map(n => n.id)) : null
  const fitOf = (drawn: GraphNode[]) => {
    const framed = (framedIds ? drawn.filter(n => framedIds.has(n.id)) : drawn).filter(n => n.kind === 'session' || n.kind === 'project')
    return fitMap(framed.length > 0 ? framed : drawn, stagePx, PANE_PAD)
  }
  let placed = nodes
  if (options.stack) {
    for (let i = 0; i < 2; i += 1) placed = stackClusters(nodes, stagePx.w / stagePx.h, labelScaleAt(stagePx.w / fitOf(placed).w))
  }
  const fit = fitOf(placed)
  const zoom = Math.max(0.25, Math.min(8, options.camera.zoom || 1))
  const w = fit.w / zoom
  const h = fit.h / zoom
  const cx = fit.x + fit.w / 2 + options.camera.panX * fit.w
  const cy = fit.y + fit.h / 2 + options.camera.panY * fit.h
  const view = zoom === 1 && options.camera.panX === 0 && options.camera.panY === 0 ? fit : { x: cx - w / 2, y: cy - h / 2, w, h }
  const k = stagePx.w / view.w
  const parts = mapParts(placed, edges, lookup, { palette: PALETTE, camera: view, stagePx, selected: options.selected, pinned: options.pinned, now: options.now, overflow: options.overflow })
  const group = (name: 'hierarchy' | 'resource' | 'lineage' | 'lit', stroke: string, extra = '') => {
    const lines = parts.edges.filter(e => e.group === name).map(e => e.markup).join('')
    return lines ? `<g stroke="${stroke}" stroke-width="${name === 'lit' ? '2' : '1'}"${extra} fill="none">${lines}</g>` : ''
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r2(view.x)} ${r2(view.y)} ${r2(view.w)} ${r2(view.h)}" width="${stagePx.w}" height="${stagePx.h}" font-family="Segoe UI Variable Text, Segoe UI, system-ui, sans-serif">` +
    LIGHT_STYLE +
    `<rect x="${r2(view.x)}" y="${r2(view.y)}" width="${r2(view.w)}" height="${r2(view.h)}" fill="${PALETTE.bg}"/>` +
    `<g class="edges">${group('hierarchy', PALETTE.lineStrong)}${group('resource', PALETTE.lineStrong, ' stroke-dasharray="3 4"')}${group('lineage', PALETTE.muted)}${group('lit', PALETTE.accent)}</g>` +
    `<g class="nodes" fill="${PALETTE.surface}" stroke-width="1.6">${parts.nodes.map(n => n.markup).join('')}</g></svg>`
  return { svg, fit, view, k, tier: tierFor(k), nodes: placed, labels: parts.labels, unlabelledNeedsYou: parts.unlabelledNeedsYou }
}
