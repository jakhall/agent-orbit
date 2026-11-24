// @ts-check

import { ACTIVE_LIFECYCLES, ATTENTION, DEGRADED, PALETTE, tintKey } from './constants.js'
import { escapeXml, plural, truncate } from './format.js'
import { statusLine, statusOf } from './popout.js'

/** @typedef {{ x: number, y: number, w: number, h: number }} Box */

/**
 * What a keyed map view must do to show `next`: the ids to add, the ids whose
 * markup changed (replace), the ids gone (remove), and whether the kept ids
 * changed their draw order.
 * @param {Map<string, string>} prev id → markup on screen
 * @param {{ id: string, markup: string }[]} next in draw order
 * @returns {{ add: string[], replace: string[], remove: string[], isReordered: boolean }}
 */
export function planPatch(prev, next) {
  /** @type {string[]} */
  const add = []
  /** @type {string[]} */
  const replace = []
  const seen = new Set()
  /** @type {string[]} */
  const kept = []
  for (const part of next) {
    seen.add(part.id)
    const old = prev.get(part.id)
    if (old === undefined) add.push(part.id)
    else {
      kept.push(part.id)
      if (old !== part.markup) replace.push(part.id)
    }
  }
  const remove = [...prev.keys()].filter(id => !seen.has(id))
  const before = [...prev.keys()].filter(id => seen.has(id))
  const isReordered = before.some((id, i) => kept[i] !== id)
  return { add, replace, remove, isReordered }
}

/**
 * @param {Box} a
 * @param {Box} b
 */
function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * How many pairs of boxes overlap (touching edges do not), for the legibility metric.
 * @param {Box[]} boxes
 * @returns {number}
 */
export function countOverlaps(boxes) {
  const sorted = [...boxes].sort((a, b) => a.x - b.x)
  let count = 0
  for (let i = 0; i < sorted.length; i += 1) {
    const a = /** @type {Box} */ (sorted[i])
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = /** @type {Box} */ (sorted[j])
      if (b.x >= a.x + a.w) break
      if (overlaps(a, b)) count += 1
    }
  }
  return count
}

/**
 * How many boxes are not wholly inside the stage.
 * @param {Box[]} boxes
 * @param {Box} stage
 * @returns {number}
 */
export function countOutside(boxes, stage) {
  return boxes.filter(b => b.x < stage.x || b.y < stage.y || b.x + b.w > stage.x + stage.w || b.y + b.h > stage.y + stage.h).length
}

/** @typedef {import('../types').GraphNode} GraphNode */
/** @typedef {import('../types').GraphEdge} GraphEdge */
/** @typedef {import('../types').SessionView} SessionView */
/** @typedef {{ x: number, y: number, w: number, h: number }} Camera */
/** @typedef {'needs-you' | 'working' | 'review' | 'idle' | 'failed'} Bucket */
/** @typedef {{ top: number, right: number, bottom: number, left: number }} Pad */

/** Labels are drawn at this size on screen at every zoom (DESIGN.md body size); one that cannot fit is dropped, never shrunk. */
export const LABEL_PX = 13
const CHAR_PX = 6.9
const LABEL_H_PX = 17
const LABEL_GAP_PX = 4
const SHORT_HEAD = 9
const SHORT_TAIL = 5
const SHORT_WORD = 10
const HALO_PX = 3

/** The smallest a session or hub title is drawn, in px (1.15's `MIN_LABEL_PX`). */
const MIN_LABEL_PX = 10
/** Below this many px per world unit only the sessions that matter are named (1.15's low-detail zoom). */
const LOW_DETAIL_K = 0.55
/** A hub's count shows once it would be at least this many px tall. */
const MIN_MARK_PX = 8
const HUB_COUNT_SIZE = 20
const MIN_MINOR_PX = 9

/** The 16x16 stroke glyph drawn in accent blue left of a node's label, by kind (DESIGN.md "Map kind icons"). */
export const KIND_ICONS = {
  session: '<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 5V2.8M1.5 8.5v2.5M14.5 8.5v2.5M6 11h4"/><circle cx="8" cy="2.2" r=".7"/><circle cx="6" cy="8.3" r=".6"/><circle cx="10" cy="8.3" r=".6"/>',
  fork: '<circle cx="4" cy="3" r="1.5"/><circle cx="12" cy="3" r="1.5"/><circle cx="8" cy="13" r="1.5"/><path d="M4 4.5v1c0 2.2 4 2.2 4 4.5v1.5M12 4.5v1c0 2.2-4 2.2-4 4.5"/>',
  agent: '<path d="M3.5 2.5v5a2.5 2.5 0 0 0 2.5 2.5h7"/><path d="M10 7l3 3-3 3"/>',
  project: '<path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
  branch: '<circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="5.5" r="1.5"/><path d="M5 5v6M11 7c0 2.5-6 1.5-6 4"/>',
}
/** @typedef {keyof typeof KIND_ICONS} KindIcon */
const ICON_EM = 0.95
const ICON_GAP_EM = 0.3

/** The extra width, in screen px, a kind icon and its gap add to a label of font size `px`. @param {number} px */
export function iconWidthPx(px) {
  return px * (ICON_EM + ICON_GAP_EM)
}

/** How much 1.15's labels grow so a title stays about 10 px on screen when zoomed out (`labelScaleFor`). @param {number} k */
export function labelScaleAt(k) {
  return Math.min(3, Math.max(1, MIN_LABEL_PX / 11.5 / k))
}

/**
 * The width a label takes on screen, estimated from its text (no DOM measure,
 * so the placement is the same on every reader).
 * @param {string} text
 * @param {number} [px] its font size
 * @param {boolean} [isBold]
 */
export function labelWidthPx(text, px = LABEL_PX, isBold = false) {
  const perChar = px === LABEL_PX && !isBold ? CHAR_PX : px * (isBold ? 0.57 : 0.53)
  return text.length * perChar + 4
}

/**
 * The semantic zoom tier for `k` screen px per world unit: 0 overview (clusters
 * and the sessions that need you), 1 sessions, 2 detail (satellites too).
 * @param {number} k
 * @returns {0 | 1 | 2}
 */
export function tierFor(k) {
  return k < 0.35 ? 0 : k < 0.9 ? 1 : 2
}

/** @param {number | Pad} pad @returns {Pad} */
const padOf = pad => (typeof pad === 'number' ? { top: pad, right: pad, bottom: pad, left: pad } : pad)

/**
 * The camera that shows every node inside the stage less `pad` (px; one
 * number, or per side to keep clear of controls), at the stage's aspect.
 * @param {readonly GraphNode[]} nodes
 * @param {{ w: number, h: number }} stage in CSS px
 * @param {number | Pad} pad
 * @returns {Camera}
 */
export function fitView(nodes, stage, pad) {
  if (nodes.length === 0) return { x: 0, y: 0, w: stage.w, h: stage.h }
  const p = padOf(pad)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.r)
    minY = Math.min(minY, n.y - n.r)
    maxX = Math.max(maxX, n.x + n.r)
    maxY = Math.max(maxY, n.y + n.r)
  }
  const innerW = Math.max(1, stage.w - p.left - p.right)
  const innerH = Math.max(1, stage.h - p.top - p.bottom)
  const k = Math.min(innerW / Math.max(1, maxX - minX), innerH / Math.max(1, maxY - minY), 2)
  const w = stage.w / k
  const h = stage.h / k
  const cx = (minX + maxX) / 2 + (p.right - p.left) / 2 / k
  const cy = (minY + maxY) / 2 + (p.bottom - p.top) / 2 / k
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

/**
 * Fit for the drawn map: every node and the room its label takes (1.15's
 * `extentOf`: a session's title on its side, a hub's name under it), which
 * grows as labels grow when zoomed out, inside the stage less `pad`.
 * @param {readonly GraphNode[]} nodes
 * @param {{ w: number, h: number }} stage
 * @param {number | Pad} pad
 * @returns {Camera}
 */
export function fitMap(nodes, stage, pad) {
  const room = (/** @type {number} */ k) => {
    const s = labelScaleAt(k)
    /** @type {GraphNode[]} */
    const out = []
    for (const n of nodes) {
      if (n.kind === 'session') out.push({ ...n, x: n.x + (n.side < 0 ? -1 : 1) * 175 * s })
      else if (n.kind === 'project') out.push({ ...n, x: n.x - 80 * s }, { ...n, x: n.x + 80 * s }, { ...n, y: n.y + n.r + 40 * s })
    }
    return out
  }
  let camera = fitView(nodes, stage, pad)
  for (let i = 0; i < 3; i += 1) camera = fitView([...nodes, ...room(stage.w / camera.w)], stage, pad)
  return camera
}

/**
 * @typedef {object} LabelCandidate
 * @property {string} id
 * @property {number} x world
 * @property {number} y world
 * @property {number} r world radius of its dot (or a small gap, for a cluster name)
 * @property {string} text
 * @property {number} priority higher places first
 * @property {boolean} [isAbove] try above first (cluster names)
 * @property {boolean} [isMust] needs you, failed, selected or a cluster name: may cover quiet dots, or move further out, or shorten, before it is dropped
 * @property {string} [cluster] the project id whose ring the label may sit in; another cluster's ring is off limits
 * @property {boolean} [isRingSoft] another ring is avoided first but allowed in the fallback passes (cluster names, whose rows sit closer than a label)
 * @property {string[]} [alternates] shorter texts a must-label may fall back to, in order (default: the title cut from the middle)
 * @property {number} [px] its font size on screen (default 13, one line, 2.0's labels)
 * @property {boolean} [isBold]
 * @property {string} [sub] a second, smaller line under it (1.15's status sub-line)
 * @property {number} [subPx]
 * @property {'end' | 'below'} [prefer] the spot to try first: to the left (a session on its hub's left), or under (a hub's name)
 * @property {'title' | 'minor'} [kind] a session or hub title, or a small worktree, PR or agent label
 * @property {KindIcon} [icon] the kind glyph drawn left of the title line
 * @property {string} [tint] the session's icon colour (default blue)
 */

/** @typedef {{ x: number, y: number, r: number, isLoud?: boolean }} Obstacle */
/** @typedef {{ x: number, y: number, anchor: 'start' | 'end' | 'middle', box: Box, text: string, spot: number, leader: boolean, px?: number, isBold?: boolean, sub?: string, subPx?: number, subY?: number, kind?: 'title' | 'minor', icon?: KindIcon, tint?: string }} Placed */

/**
 * Places labels greedily in priority order at 13 px on screen. Each tries 8
 * spots around its dot (its previous spot first, so labels hold still); a
 * spot that overlaps a placed label, covers a dot, enters another cluster's
 * ring, lies on a reserved box or leaves the stage is skipped. A must-label
 * may then cover quiet dots (never a needs-you or selected one), move a
 * label-height further out, or shorten its title; anything else is dropped,
 * never shrunk.
 * @param {readonly LabelCandidate[]} candidates
 * @param {Camera} view the world rectangle on screen
 * @param {number} k screen px per world unit
 * @param {readonly Obstacle[]} obstacles dots to keep clear of (world); `isLoud` ones even must-labels avoid
 * @param {{ reserved?: readonly Box[], previous?: ReadonlyMap<string, number>, clusters?: readonly { id: string, x: number, y: number, r: number }[] }} [more] screen boxes to keep clear (controls), each label's last spot, cluster rings (world)
 * @returns {Map<string, Placed>}
 */
export function placeLabels(candidates, view, k, obstacles, more = {}) {
  const cell = 64
  /** @type {Map<string, Box[]>} */
  const all = new Map()
  /** @type {Map<string, Box[]>} */
  const loud = new Map()
  const keys = (/** @type {Box} */ b) => {
    const out = []
    for (let gx = Math.floor(b.x / cell); gx <= Math.floor((b.x + b.w) / cell); gx += 1) for (let gy = Math.floor(b.y / cell); gy <= Math.floor((b.y + b.h) / cell); gy += 1) out.push(`${gx},${gy}`)
    return out
  }
  const add = (/** @type {Map<string, Box[]>} */ grid, /** @type {Box} */ b) => {
    for (const key of keys(b)) {
      const cell = grid.get(key)
      if (cell) cell.push(b)
      else grid.set(key, [b])
    }
  }
  const remove = (/** @type {Map<string, Box[]>} */ grid, /** @type {Box} */ b) => {
    for (const key of keys(b)) {
      const cell = grid.get(key)
      const i = cell ? cell.indexOf(b) : -1
      if (cell && i >= 0) cell.splice(i, 1)
    }
  }
  const clear = (/** @type {Map<string, Box[]>} */ grid, /** @type {Box} */ b) => keys(b).every(key => !(grid.get(key) ?? []).some(o => overlaps(o, b)))
  const screen = (/** @type {number} */ x, /** @type {number} */ y) => ({ x: (x - view.x) * k, y: (y - view.y) * k })
  const stageW = view.w * k
  const stageH = view.h * k
  const dots = obstacles.map(o => {
    const p = screen(o.x, o.y)
    const r = Math.max(o.r * k, 2)
    return { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r, cx: p.x, cy: p.y, isLoud: o.isLoud === true }
  })
  for (const d of dots) {
    add(all, d)
    if (d.isLoud) add(loud, d)
  }
  for (const b of more.reserved ?? []) {
    add(all, b)
    add(loud, b)
  }
  const rings = (more.clusters ?? []).map(c => ({ id: c.id, ...screen(c.x, c.y), r: c.r * k }))
  const inForeignRing = (/** @type {Box} */ b, /** @type {string | undefined} */ own) =>
    own !== undefined && rings.some(c => c.id !== own && boxMeetsCircle(b, c.x, c.y, c.r))
  /** @type {Map<string, Placed>} */
  const placed = new Map()
  const order = [...candidates].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  for (const c of order) {
    const p = screen(c.x, c.y)
    const r = Math.max(c.r * k, 2)
    const isSized = c.px !== undefined
    const px = c.px ?? LABEL_PX
    const subPx = c.subPx ?? px
    const lineH = (/** @type {number} */ size) => (isSized ? size * 1.3 : LABEL_H_PX)
    const h = lineH(px) + (c.sub ? lineH(subPx) : 0)
    const own = dots.filter(d => d.cx === p.x && d.cy === p.y)
    for (const d of own) {
      remove(all, d)
      if (d.isLoud) remove(loud, d)
    }
    const gap = isSized && c.kind !== 'minor' ? 9 * k : LABEL_GAP_PX
    const near = (/** @type {number} */ w) =>
      /** @type {{ box: Box, anchor: 'start' | 'end' | 'middle', tx: number, ty: number }[]} */ ([
        { box: { x: p.x + r + gap, y: p.y - h / 2, w, h }, anchor: 'start', tx: p.x + r + gap, ty: p.y + 4 },
        { box: { x: p.x - r - gap - w, y: p.y - h / 2, w, h }, anchor: 'end', tx: p.x - r - gap, ty: p.y + 4 },
        { box: { x: p.x - w / 2, y: p.y + r + 2, w, h }, anchor: 'middle', tx: p.x, ty: p.y + r + 14 },
        { box: { x: p.x - w / 2, y: p.y - r - 2 - h, w, h }, anchor: 'middle', tx: p.x, ty: p.y - r - 6 },
        { box: { x: p.x + r, y: p.y - r - h, w, h }, anchor: 'start', tx: p.x + r, ty: p.y - r - 4 },
        { box: { x: p.x + r, y: p.y + r, w, h }, anchor: 'start', tx: p.x + r, ty: p.y + r + 13 },
        { box: { x: p.x - r - w, y: p.y - r - h, w, h }, anchor: 'end', tx: p.x - r, ty: p.y - r - 4 },
        { box: { x: p.x - r - w, y: p.y + r, w, h }, anchor: 'end', tx: p.x - r, ty: p.y + r + 13 },
      ])
    const spotsFor = (/** @type {string} */ text, /** @type {number} */ limit) => {
      const w = isSized ? Math.max(labelWidthPx(text, px, c.isBold) + (c.icon ? iconWidthPx(px) : 0), c.sub ? labelWidthPx(c.sub, subPx) : 0) : labelWidthPx(text)
      const base = near(w)
      if (c.isAbove) base.unshift(.../** @type {any[]} */ (base.splice(3, 1)))
      else if (c.prefer === 'below') base.unshift(.../** @type {any[]} */ (base.splice(2, 1)))
      else if (c.prefer === 'end') base.unshift(.../** @type {any[]} */ (base.splice(1, 1)))
      return limit <= base.length ? base : [...base, ...near(w).map(s => shifted(s, p, h + 4))]
    }
    const onStage = (/** @type {Box} */ b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= stageW && b.y + b.h <= stageH
    const fits = (/** @type {Box} */ b, /** @type {Map<string, Box[]>} */ grid) => onStage(b) && clear(grid, b) && (grid === loud && c.isRingSoft ? true : !inForeignRing(b, c.cluster))
    const previous = more.previous?.get(c.id)
    /** @type {{ text: string, i: number, spot: { box: Box, anchor: 'start' | 'end' | 'middle', tx: number, ty: number } } | null} */
    let found = null
    const tryText = (/** @type {string} */ text, /** @type {Map<string, Box[]>} */ grid, /** @type {number} */ limit) => {
      const spots = spotsFor(text, Math.max(limit, previous !== undefined ? previous + 1 : 0))
      const indexes = [...(previous !== undefined && previous < limit ? [previous] : []), ...spots.keys()].filter(i => i < limit)
      for (const i of indexes) {
        const spot = spots[i]
        if (spot && fits(spot.box, grid)) return { text, i, spot }
      }
      return null
    }
    found = isSized && c.isMust ? (tryText(c.text, all, 4) ?? tryText(c.text, loud, 4) ?? tryText(c.text, all, 8)) : tryText(c.text, all, 8)
    if (!found && c.isMust) found = tryText(c.text, loud, 8) ?? tryText(c.text, loud, 16)
    if (!found && c.isMust) {
      for (const text of c.alternates ?? [shortTitle(c.text)]) {
        if (text === c.text) continue
        found = tryText(text, loud, 16)
        if (found) break
      }
    }
    for (const d of own) {
      add(all, d)
      if (d.isLoud) add(loud, d)
    }
    if (!found) continue
    add(all, found.spot.box)
    add(loud, found.spot.box)
    const box = found.spot.box
    const ty = isSized ? box.y + lineH(px) / 2 + px * 0.35 : found.spot.ty
    const subY = isSized && c.sub ? view.y + (box.y + lineH(px) + lineH(subPx) / 2 + subPx * 0.35) / k : undefined
    placed.set(c.id, { x: view.x + found.spot.tx / k, y: view.y + ty / k, anchor: found.spot.anchor, box, text: found.text, spot: found.i, leader: found.i >= 4, ...(isSized ? { px, isBold: c.isBold === true, kind: c.kind ?? 'title', ...(c.icon ? { icon: c.icon } : {}), ...(c.tint ? { tint: c.tint } : {}) } : {}), ...(c.sub ? { sub: c.sub, subPx, subY } : {}) })
  }
  return placed
}

/**
 * @param {Box} b
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 */
function boxMeetsCircle(b, cx, cy, r) {
  const nx = Math.max(b.x, Math.min(cx, b.x + b.w))
  const ny = Math.max(b.y, Math.min(cy, b.y + b.h))
  return Math.hypot(nx - cx, ny - cy) < r
}

/**
 * A label spot moved further from its dot, away from the dot's centre.
 * @param {{ box: Box, anchor: 'start' | 'end' | 'middle', tx: number, ty: number }} s
 * @param {{ x: number, y: number }} p
 * @param {number} by
 */
function shifted(s, p, by) {
  const cx = s.box.x + s.box.w / 2 - p.x
  const cy = s.box.y + s.box.h / 2 - p.y
  const len = Math.hypot(cx, cy) || 1
  const dx = (cx / len) * by
  const dy = (cy / len) * by
  return { box: { ...s.box, x: s.box.x + dx, y: s.box.y + dy }, anchor: s.anchor, tx: s.tx + dx, ty: s.ty + dy }
}

/** A title cut from the middle, keeping its start and its last word (or last few characters), which usually tell sessions apart; never inside a word when a space allows. @param {string} text */
export function shortTitle(text) {
  if (text.length <= SHORT_HEAD + SHORT_TAIL + 1) return text
  let head = text.slice(0, SHORT_HEAD)
  const headSpace = head.lastIndexOf(' ')
  if (!/\s/.test(text[SHORT_HEAD] ?? '') && headSpace >= 3) head = head.slice(0, headSpace)
  const space = text.lastIndexOf(' ')
  const word = text.slice(space + 1)
  let tail = space >= SHORT_HEAD && word.length <= SHORT_WORD ? word : text.slice(-SHORT_TAIL).trimStart()
  const tailSpace = tail.indexOf(' ')
  if (tail !== word && tailSpace >= 0 && tailSpace < tail.length - 1) tail = tail.slice(tailSpace + 1)
  return `${head.trimEnd()}…${tail}`
}

/**
 * A session's D-4 bucket, from its `status`, or worked out from older fields.
 * @param {SessionView | undefined} s
 * @returns {Bucket}
 */
export function bucketOf(s) {
  if (!s) return 'idle'
  const status = /** @type {{ status?: { bucket?: Bucket } }} */ (/** @type {unknown} */ (s)).status
  if (status?.bucket) return status.bucket
  if (s.attention && ATTENTION[s.attention]?.isUrgent) return 'needs-you'
  if (s.lifecycle === 'failed') return 'failed'
  if (s.lifecycle === 'running' || s.lifecycle === 'stale') return 'working'
  return 'idle'
}

/** The palette colour each D-4 bucket is drawn in (dots only, per DESIGN.md). */
export const BUCKET_COLOR_KEY = { 'needs-you': 'amber', failed: 'coral', review: 'green', working: 'accent', idle: 'dim' }

/**
 * A bucket's dot colour in a palette (PALETTE or PALETTE_LIGHT).
 * @param {Bucket} bucket
 * @param {Record<string, string>} palette
 */
export function bucketColor(bucket, palette) {
  return palette[BUCKET_COLOR_KEY[bucket]] ?? palette.dim
}

/** A needs-you count in words, one way everywhere: "1 needs you", "3 need you". @param {number} n */
export function needsYouText(n) {
  return `${n} need${n === 1 ? 's' : ''} you`
}

/**
 * The sessions a view lists, once each: those that need you, the pinned, then the rest (the page's rail and the pane's queue share it).
 * @param {{ attention: SessionView[], pinned: SessionView[], sessions: SessionView[] } | null | undefined} visible
 * @returns {SessionView[]}
 */
export function listedSessions(visible) {
  if (!visible) return []
  const byKey = new Map()
  for (const s of [...visible.attention, ...visible.pinned, ...visible.sessions]) if (!byKey.has(s.key)) byKey.set(s.key, s)
  return [...byKey.values()]
}
const BUCKET_PRIORITY = { 'needs-you': 6, failed: 5, review: 3, working: 2, idle: 1 }

/** @param {number} n */
const f = n => String(Math.round(n * 100) / 100)

const BUCKET_NAME = { 'needs-you': 'Needs you', failed: 'Failed', review: 'Ready for review', working: 'Working', idle: 'Idle' }
/** How a session's project was decided (G-17), one wording for map and panel. */
export const SOURCE_TEXT = { edits: 'by its edits', folder: 'by its start folder', override: 'set by you' }
const PARENT_TEXT = { 'side-session': 'Side session of', fork: 'Forked from', 'hand-off': 'Handed off from', spawn: 'Started from' }
const HOUR = 3_600_000

/**
 * How long ago a session was last active, in coarse steps (the hour, hours,
 * days), so the text, and the markup that carries it, changes at most hourly.
 * @param {number | null | undefined} at
 * @param {number} now
 * @returns {string}
 */
export function ageText(at, now) {
  if (typeof at !== 'number') return 'no activity yet'
  const ms = Math.max(0, now - at)
  if (ms < HOUR) return 'active in the last hour'
  if (ms < 24 * HOUR) return `active ${Math.floor(ms / HOUR)}h ago`
  return `active ${Math.floor(ms / (24 * HOUR))}d ago`
}

/**
 * The age that belongs to a bucket, matching the rail: how long it has waited
 * or been failed (from `status.since`), else when it was last active.
 * @param {Bucket} bucket
 * @param {number | null | undefined} since
 * @param {number | null | undefined} lastActivityAt
 * @param {number} now
 */
export function bucketAge(bucket, since, lastActivityAt, now) {
  const coarse = (/** @type {number} */ ms) => (ms < HOUR ? 'under an hour' : ms < 24 * HOUR ? `${Math.floor(ms / HOUR)}h` : `${Math.floor(ms / (24 * HOUR))}d`)
  if (bucket === 'needs-you' && typeof since === 'number') return `waiting ${coarse(Math.max(0, now - since))}`
  if (bucket === 'failed' && typeof since === 'number') return `failed ${coarse(Math.max(0, now - since))} ago`
  return ageText(lastActivityAt, now)
}

/**
 * The project override menu (G-17): Automatic, then every project by name.
 * @param {readonly { id: string, name: string }[]} projects
 * @param {string | null} current the override set for the session, or null
 * @param {string | null} [automaticName] the project Orbit picks on its own, named on the Automatic choice
 * @returns {{ value: string, label: string, isCurrent: boolean }[]}
 */
export function projectChoices(projects, current, automaticName = null) {
  return [{ value: '', label: automaticName ? `Automatic (${automaticName})` : 'Automatic', isCurrent: current === null }, ...[...projects].sort((a, b) => a.name.localeCompare(b.name)).map(p => ({ value: p.id, label: p.name, isCurrent: p.id === current }))]
}

/**
 * The escaped tooltip text per session object, kept for the minute it describes (ages read in minutes).
 * @type {WeakMap<object, { key: string, text: string }>}
 */
const titleCache = new WeakMap()

/**
 * @param {SessionView | undefined} s
 * @param {Bucket} bucket
 * @param {{ sessions: Map<string, SessionView>, projects: Map<string, { name: string }> }} lookup
 * @param {number} now
 * @param {number} hidden
 */
function titleOf(s, bucket, lookup, now, hidden) {
  const key = `${bucket}|${Math.floor(now / 60_000)}|${hidden}|${lookup.projects.size}`
  const hit = s ? titleCache.get(s) : undefined
  if (hit && hit.key === key) return hit.text
  const text = escapeXml(sessionName(s, bucket, lookup, now, hidden))
  if (s) titleCache.set(s, { key, text })
  return text
}

/**
 * A session's text name on the map: title, bucket, reason (without repeating the bucket), its age, the ask, project and how it got there, lineage, hidden sub-agents.
 * @param {SessionView | undefined} s
 * @param {Bucket} bucket
 * @param {{ sessions: Map<string, SessionView>, projects: Map<string, { name: string }> }} lookup
 * @param {number} now
 * @param {number} [hidden] sub-agents past the cap, not drawn
 */
export function sessionName(s, bucket, lookup, now, hidden = 0) {
  if (!s) return ''
  const status = /** @type {{ status?: { reason?: string, since?: number | null }, projectSource?: keyof typeof SOURCE_TEXT, parent?: { key: string, kind: keyof typeof PARENT_TEXT } | null }} */ (/** @type {unknown} */ (s))
  const name = BUCKET_NAME[bucket]
  const raw = status.status?.reason ?? ''
  const reason = raw && raw !== name ? (raw.startsWith(name) ? raw.slice(name.length).replace(/^[\s·:(-]+|\)$/g, '') : raw) : ''
  const hasAge = /\b\d+\s?(s|m|h|d)\b|\bago\b/.test(reason)
  const lines = [s.title, [name, reason || null, hasAge ? null : bucketAge(bucket, status.status?.since, s.lastActivityAt, now)].filter(Boolean).join(' · ')]
  if (s.lastReport?.ask) lines.push(`Asks: ${s.lastReport.ask}`)
  const project = lookup.projects.get(s.projectId)?.name
  if (project) lines.push(`In ${project}${status.projectSource ? `, ${SOURCE_TEXT[status.projectSource]}` : ''}`)
  if (status.parent) lines.push(`${PARENT_TEXT[status.parent.kind] ?? 'Started from'} ${lookup.sessions.get(status.parent.key)?.title ?? 'a session Orbit does not list'}`)
  if (hidden > 0) lines.push(`${hidden} more sub-agent${hidden === 1 ? '' : 's'} not drawn`)
  return lines.join('\n')
}

const CARD_BODY_MAX = 240

/**
 * The map's hover card, minimal (2.1.2): a title row with the actions
 * (Pin, Done, Snooze, and Hide unless it needs you; Open stays in the panel),
 * one status line worded as the session's row (`statusLine`), project and
 * branch facts when known, and one text block:
 * the ask for a session that needs you, else its last report.
 * @param {SessionView} s
 * @param {Bucket} bucket
 * @param {{ projects: Map<string, { name: string }> }} lookup
 * @param {number} now
 * @returns {{ head: { title: string, actions: ('pin' | 'done' | 'snooze' | 'hide')[] }, status: string, facts: { icon: 'folder' | 'branch', text: string, label: string }[], body: string | null }}
 */
export function cardModel(s, bucket, lookup, now) {
  const view = /** @type {{ cwd?: string | null, branch?: string | null, lastReport?: { text?: string | null, ask?: string | null } | null }} */ (/** @type {unknown} */ (s))
  const project = lookup.projects.get(s.projectId)?.name
  const fold = (/** @type {string | null | undefined} */ t) => (t ?? '').replace(/\s+/g, ' ').trim()
  const ask = fold(view.lastReport?.ask)
  const report = fold(view.lastReport?.text)
  const body = (bucket === 'needs-you' && ask) || report || null
  return {
    head: { title: s.title, actions: bucket === 'needs-you' ? ['pin', 'done', 'snooze'] : ['pin', 'done', 'snooze', 'hide'] },
    status: statusLine(statusOf(s), now),
    facts: [
      project ? { icon: /** @type {const} */ ('folder'), text: project, label: `Project${view.cwd ? ` · ${view.cwd}` : ''}` } : null,
      view.branch ? { icon: /** @type {const} */ ('branch'), text: view.branch, label: 'Branch' } : null,
    ].filter(f => f !== null),
    body: body ? truncate(body, CARD_BODY_MAX) : null,
  }
}

/**
 * The constellation as keyed markup for the camera, drawn as 1.15.2 drew it
 * (`renderNode` at `orbit-1.15.2`), in world units so it scales with the
 * zoom: hexagon project hubs with their session count inside, spokes to
 * their sessions, ringed session circles with a status dot in the D-4
 * bucket's colour (an outer ring when the session needs you), satellites,
 * worktree diamonds and PR squares on dashed links, the selection's own
 * outline (and its project hexagon's) in the accent with its links lit and
 * the rest dimmed, and a "+N" pill for hidden children.
 * Labels are 1.15's (a bold title over a status sub-line, a hub's name over
 * "N sessions · M running") placed by `placeLabels`, so none overlap; the
 * sub-lines show only when not zoomed out, and at low detail only what
 * matters is named. Lineage stays as a dashed link. A session's link to its
 * worktree shows only while the session or the worktree is selected (2.1.5).
 * Focus (2.1.5): the selection and its direct neighbours stay full, the
 * selection's outline and its hexagon's and its links drawn in the accent; everything else fades.
 * A selected project (2.1.8) keeps everything under it full and lights every
 * link inside it; its sessions' and sub-agents' outlines turn the accent too (2.1.9).
 * Idle sessions outside a selection fade too, unless pinned or matched.
 * `animation` brings back 1.15's pulses (2.1.5): Low pulses the ring of a
 * session that needs you, Normal also the dot of a working one; Off draws none.
 * Since 2.2.5 the needs-you pulse is a sonar ping; since 2.2.11 it has no steady outer ring
 * (one ring like every session); since 2.2.18 its dot has no edge either.
 * @param {readonly GraphNode[]} nodes
 * @param {readonly GraphEdge[]} edges
 * @param {{ sessions: Map<string, SessionView>, projects: Map<string, { name: string, tint?: string }>, agents?: Map<string, any> }} lookup
 * @param {{ palette?: Record<string, string>, camera: Camera, stagePx: { w: number, h: number }, selected: string | null, reserved?: readonly Box[], previous?: ReadonlyMap<string, number>, pinned?: ReadonlySet<string>, now?: number, overflow?: Record<string, { count: number, noun: string, reason?: string }>, focused?: string | null, matches?: ReadonlySet<string>, animation?: 'off' | 'low' | 'normal' }} options
 * @returns {{ nodes: { id: string, markup: string }[], edges: { id: string, group: 'hierarchy' | 'resource' | 'lineage' | 'lit', markup: string }[], placement: Map<string, number>, labels: Map<string, Placed>, unlabelledNeedsYou: number }}
 */
export function mapParts(nodes, edges, lookup, options) {
  const P = /** @type {Record<string, string>} */ (options.palette ?? PALETTE)
  const pal = (/** @type {string} */ key, /** @type {string} */ fallback) => P[key] ?? P[fallback] ?? PALETTE.text
  const C = {
    bg: pal('bg', 'bg'),
    bg2: pal('bg2', 'surface'),
    bg3: pal('bg3', 'raised'),
    label: pal('label', 'text'),
    text: pal('text', 'text'),
    muted: pal('muted', 'muted'),
    faint: pal('faint', 'muted'),
    grey: pal('grey', 'muted'),
    dim: pal('dim', 'dim'),
    lineStrong: pal('lineStrong', 'lineStrong'),
    controlEdge: pal('controlEdge', 'controlEdge'),
    accent: pal('accent', 'text'),
  }
  const now = options.now ?? 0
  const k = options.stagePx.w / options.camera.w
  const tier = tierFor(k)
  const scale = labelScaleAt(k)
  const isLowDetail = k < LOW_DETAIL_K
  const showSub = !isLowDetail && scale <= 1.05
  const hasSonar = options.animation === 'low' || options.animation === 'normal'
  const pulseDot = options.animation === 'normal' ? pulse('fill-opacity', '.15;1;.15', 1.6) : ''
  const byId = new Map(nodes.map(n => [n.id, n]))
  const selected = options.selected
  /** @type {Set<string>} */
  const lit = new Set()
  const isProjectFocus = byId.get(selected ?? '')?.kind === 'project'
  if (isProjectFocus) {
    for (const n of nodes) {
      for (let at = /** @type {GraphNode | undefined} */ (n), hops = 0; at && hops < 5; at = at.parent ? byId.get(at.parent) : undefined, hops += 1) {
        if (at.id !== selected) continue
        lit.add(n.id)
        break
      }
    }
  } else if (selected && byId.has(selected)) {
    lit.add(selected)
    for (const e of edges) {
      if (e.from === selected) lit.add(e.to)
      if (e.to === selected) lit.add(e.from)
    }
  }
  /** @type {string | null} */
  let selectedHub = null
  for (let at = selected ? byId.get(selected) : undefined, hops = 0; at && hops < 4; at = at.parent ? byId.get(at.parent) : undefined, hops += 1) {
    if (at.kind === 'project') {
      selectedHub = at.id
      break
    }
  }
  const isQuietIdle = (/** @type {GraphNode} */ n) => n.kind === 'session' && bucketOf(lookup.sessions.get(n.ref)) === 'idle' && !lit.has(n.id) && options.pinned?.has(n.ref) !== true && options.matches?.has(n.id) !== true
  const opacityOf = (/** @type {GraphNode} */ n) => (lit.size > 0 && !lit.has(n.id) ? OUT_OF_FOCUS_OPACITY : isQuietIdle(n) ? IDLE_OPACITY : 1)
  /** @type {Map<string, { total: number, running: number, needs: number }>} */
  const counts = new Map()
  for (const n of nodes) {
    if (n.kind !== 'session' || !n.parent) continue
    const c = counts.get(n.parent) ?? { total: 0, running: 0, needs: 0 }
    const bucket = bucketOf(lookup.sessions.get(n.ref))
    c.total += 1
    if (bucket === 'working') c.running += 1
    if (bucket === 'needs-you') c.needs += 1
    counts.set(n.parent, c)
  }
  const sessionR = (/** @type {GraphNode} */ n, /** @type {Bucket} */ bucket) => (bucket === 'needs-you' ? n.r + 2 : n.r)
  /** @type {LabelCandidate[]} */
  const candidates = []
  /** @type {Obstacle[]} */
  const obstacles = []
  for (const n of nodes) {
    if (n.kind === 'project') {
      const c = counts.get(n.id) ?? { total: 0, running: 0, needs: 0 }
      const project = lookup.projects.get(n.ref)
      const name = truncate(project?.name ?? n.label, scale > 1.5 ? 20 : 28)
      const sub = showSub ? `${plural(c.total, 'session')}${c.running > 0 ? ` · ${c.running} running` : ''}${c.needs > 0 ? ` · ${needsYouText(c.needs)}` : ''}` : c.needs > 0 ? needsYouText(c.needs) : undefined
      candidates.push({ id: n.id, kind: 'title', x: n.x, y: n.y, r: n.r + 2 / k, text: name, px: Math.max(MIN_LABEL_PX, 12 * scale * k), isBold: true, sub, subPx: showSub ? 9.5 * k : 9, prefer: 'below', priority: 7.5 + Math.min(c.needs, 99) * 0.01, isMust: true, alternates: [shortTitle(name)], icon: 'project', ...(project?.tint ? { tint: project.tint } : {}) })
      obstacles.push({ x: n.x, y: n.y, r: n.r, isLoud: true })
    } else if (n.kind === 'session') {
      const s = lookup.sessions.get(n.ref)
      const bucket = bucketOf(s)
      const r = sessionR(n, bucket)
      const isSelected = selected === n.id
      const isPinned = options.pinned?.has(n.ref) === true
      const isMatch = options.matches?.has(n.id) === true
      const isLoud = bucket === 'needs-you' || bucket === 'failed' || isSelected
      const isImportant = isLoud || bucket === 'working' || lit.has(n.id) || isPinned || isMatch
      obstacles.push({ x: n.x, y: n.y, r: bucket === 'needs-you' ? r + 6 : r, isLoud })
      if (isLowDetail && !isImportant) continue
      const age = (s?.createdAt ?? 0) / 1e14
      candidates.push({
        id: n.id,
        kind: 'title',
        x: n.x,
        y: n.y,
        r: bucket === 'needs-you' ? r + 6 : r,
        text: truncate(s?.title ?? n.label, scale > 1.5 ? 22 : 30),
        px: Math.max(MIN_LABEL_PX, 11.5 * scale * k),
        isBold: true,
        prefer: n.side < 0 ? 'end' : undefined,
        priority: (isSelected ? 10 : BUCKET_PRIORITY[bucket] + (isPinned ? 0.5 : 0)) - age,
        isMust: isLoud || isMatch,
        icon: s?.parent?.kind === 'fork' ? 'fork' : 'session',
        ...(s?.tint ? { tint: s.tint } : {}),
      })
    } else if (n.kind === 'agent') {
      obstacles.push({ x: n.x, y: n.y, r: n.r })
      if (selected === n.id || lit.has(n.id)) {
        const a = lookup.agents?.get(n.ref)
        candidates.push({ id: n.id, kind: 'minor', x: n.x, y: n.y, r: n.r, text: truncate(a?.description || n.label, 34), px: Math.max(MIN_MINOR_PX, 9.5 * k), priority: 4, prefer: n.side < 0 ? 'end' : undefined, icon: 'agent' })
      }
    } else if (n.kind === 'worktree') {
      obstacles.push({ x: n.x, y: n.y, r: n.r })
      if (!isLowDetail) candidates.push({ id: n.id, kind: 'minor', x: n.x, y: n.y, r: n.r, text: truncate(n.label, 26), px: 9 * k, priority: 1, icon: 'branch' })
    } else if (n.kind === 'pr') {
      obstacles.push({ x: n.x, y: n.y, r: 6 })
      if (!isLowDetail) candidates.push({ id: n.id, kind: 'minor', x: n.x, y: n.y, r: 6, text: prNumberOf(n.label), px: 9 * k, priority: 1.2 })
    }
  }
  const placed = placeLabels(candidates, options.camera, k, obstacles, { reserved: options.reserved, previous: options.previous })
  const halo = `stroke="${C.bg}" stroke-width="${f(HALO_PX / k)}" paint-order="stroke" stroke-linejoin="round"`
  const labelOf = (/** @type {GraphNode} */ n, /** @type {string} */ fill, /** @type {string} */ subFill, /** @type {number} */ dot) => {
    const at = placed.get(n.id)
    if (!at) return ''
    const lx = at.x - n.x
    const ly = at.y - n.y
    const len = Math.hypot(lx, ly) || 1
    const leader = at.leader && dot > 0 && len > dot ? `<line x1="${f((lx / len) * dot)}" y1="${f((ly / len) * dot)}" x2="${f(lx)}" y2="${f(ly - 4 / k)}" stroke="${C.muted}" stroke-width="${f(1 / k)}"/>` : ''
    const px = at.px ?? LABEL_PX
    const iconW = at.icon ? iconWidthPx(px) : 0
    const textW = labelWidthPx(at.text, px, at.isBold) - 4
    const iconLeft = at.anchor === 'start' ? lx : at.anchor === 'end' ? lx - (textW + iconW) / k : lx - (textW + iconW) / 2 / k
    const textX = at.icon && at.anchor === 'start' ? lx + iconW / k : at.icon && at.anchor === 'middle' ? lx + iconW / 2 / k : lx
    const iconSize = (px * ICON_EM) / k
    const glyph = at.icon ? KIND_ICONS[at.icon] : ''
    const fit = at.anchor === 'start' ? '' : ` data-fit="${at.anchor}" data-gap="${f(iconW / k)}"`
    const icon = glyph ? `<g class="kind-icon"${fit} transform="translate(${f(iconLeft)} ${f(ly - (px * 0.35) / k - iconSize / 2)}) scale(${Math.round((iconSize / 16) * 1000) / 1000})" fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="${C.bg}" stroke-width="4">${glyph}</g><g stroke="${at.tint ? pal(tintKey(at.tint), 'accent') : C.accent}" stroke-width="1.6">${glyph}</g></g>` : ''
    const title = `${icon}<text x="${f(textX)}" y="${f(ly)}" font-size="${f(px / k)}" text-anchor="${at.anchor}"${at.isBold ? ' font-weight="600"' : ''} fill="${fill}" ${halo}>${escapeXml(at.text)}</text>`
    const sub = at.sub && at.subY !== undefined ? `<text x="${f(lx)}" y="${f(at.subY - n.y)}" font-size="${f((at.subPx ?? 9) / k)}" text-anchor="${at.anchor}" fill="${subFill}" ${halo}>${escapeXml(at.sub)}</text>` : ''
    return `${leader}${title}${sub}`
  }

  /** @type {{ id: string, layer: number, markup: string }[]} */
  const out = []
  let unlabelledNeedsYou = 0
  for (const n of nodes) {
    const opacity = opacityOf(n)
    const isDim = opacity === OUT_OF_FOCUS_OPACITY
    const head = `<g class="n k-${n.kind}" data-id="${escapeXml(n.id)}"${n.parent ? ` data-parent="${escapeXml(n.parent)}"` : ''} transform="translate(${f(n.x)} ${f(n.y)})">`
    const end = opacity < 1 ? '</g></g>' : '</g>'
    const under = (/** @type {string} */ shape) => (opacity < 1 ? `${shape.replace(/ fill="[^"]*" stroke="[^"]*"/, ` fill="${C.bg}" stroke="${C.bg}"`).replace(/ stroke-dasharray="[^"]*"/, '')}<g opacity="${opacity}">` : '')
    const isSelected = selected === n.id
    const isOutlined = isSelected || (isProjectFocus && lit.has(n.id))
    const hidden = options.overflow?.[n.id]
    const pill = hidden ? overflowPillOf(n, hidden, scale, C) : ''
    if (n.kind === 'project') {
      const c = counts.get(n.id) ?? { total: 0, running: 0, needs: 0 }
      const count = k * HUB_COUNT_SIZE >= MIN_MARK_PX ? `<text y="7" text-anchor="middle" font-size="${HUB_COUNT_SIZE}" font-weight="700" fill="${isDim ? C.muted : C.label}">${c.total}</text>` : ''
      const name = lookup.projects.get(n.ref)?.name ?? n.label
      const hex = `<polygon points="${hexagonPoints(n.r)}" fill="${C.bg2}" stroke="${selectedHub === n.id ? C.accent : C.lineStrong}" stroke-width="${selectedHub === n.id ? 2 : 1.5}"/>`
      out.push({ id: n.id, layer: 3, markup: `${head}${under(hex)}<title>${escapeXml(`${name}\n${plural(c.total, 'session')}`)}</title>${hex}${count}${pill}${labelOf(n, isDim ? C.muted : C.label, C.muted, 0)}${end}` })
    } else if (n.kind === 'session') {
      const s = lookup.sessions.get(n.ref)
      const bucket = bucketOf(s)
      const r = sessionR(n, bucket)
      if (bucket === 'needs-you' && !placed.has(n.id)) unlabelledNeedsYou += 1
      const lifecycle = s?.lifecycle ?? 'unknown'
      const isDegraded = DEGRADED.includes(lifecycle)
      const urgent = bucket === 'needs-you' && hasSonar ? sonar(r, C.label) : ''
      const ringStroke = isDegraded ? C.dim : bucket === 'needs-you' || bucket === 'working' || ACTIVE_LIFECYCLES.includes(lifecycle) ? C.label : C.grey
      const ring = `<circle r="${f(r)}" fill="${C.bg2}" stroke="${isOutlined ? C.accent : ringStroke}" stroke-width="${isOutlined ? 2.5 : 2}"${isDegraded ? ' stroke-dasharray="3 3"' : ''}/>`
      const dot = bucket === 'idle' || (isDegraded && bucket === 'working') ? '' : `<circle r="4" fill="${bucketColor(bucket, P)}">${bucket === 'working' ? pulseDot : ''}</circle>`
      const match = options.matches?.has(n.id) ? `<circle r="${f(r + 4)}" fill="none" stroke="${C.text}" stroke-width="1.5"/>` : ''
      const pinSize = 4
      const pin = options.pinned?.has(n.ref) === true ? `<path class="pin" d="M0 ${-pinSize}L${pinSize} 0L0 ${pinSize}L${-pinSize} 0Z" transform="translate(${f(r * 0.85)} ${f(-r * 0.85)})" fill="${C.text}" stroke="${C.bg}" stroke-width="1"/>` : ''
      const hiddenCount = hidden && hidden.noun === 'subagent' ? hidden.count : 0
      const titleFill = isDim ? C.muted : isDegraded ? C.label : C.text
      const subFill = bucket === 'needs-you' && !isDim ? C.label : C.faint
      out.push({ id: n.id, layer: selected === n.id ? 9 : bucket === 'needs-you' ? 4.5 : 4, markup: `${head}${under(ring)}<title>${titleOf(s, bucket, lookup, now, hiddenCount)}${pin ? ' · Pinned' : ''}</title>${urgent}${ring}${dot}${match}${pin}${pill}${labelOf(n, titleFill, subFill, r)}${end}` })
    } else if (n.kind === 'agent') {
      const a = lookup.agents?.get(n.ref)
      const lifecycle = a?.lifecycle ?? 'unknown'
      const bucket = /** @type {Bucket} */ (a?.status?.bucket ?? (lifecycle === 'running' ? 'working' : lifecycle === 'failed' ? 'failed' : 'idle'))
      const ringStroke = DEGRADED.includes(lifecycle) ? C.dim : lifecycle === 'running' ? C.label : C.grey
      const dotBucket = lifecycle === 'completed' ? 'review' : bucket === 'working' || bucket === 'failed' ? bucket : null
      const ring = `<circle r="${f(n.r)}" fill="${C.bg2}" stroke="${isOutlined ? C.accent : ringStroke}" stroke-width="${isOutlined ? 2 : 1.6}"/>`
      const dot = dotBucket ? `<circle r="2.4" fill="${bucketColor(dotBucket, P)}"/>` : ''
      out.push({ id: n.id, layer: 2, markup: `${head}${under(ring)}${ring}${dot}${labelOf(n, C.label, C.faint, n.r)}${end}` })
    } else if (n.kind === 'worktree') {
      const diamond = `<polygon points="0,${f(-n.r)} ${f(n.r)},0 0,${f(n.r)} ${f(-n.r)},0" fill="${C.bg}" stroke="${C.muted}"/>`
      out.push({ id: n.id, layer: 1, markup: `${head}${under(diamond)}${diamond}${labelOf(n, C.muted, C.muted, n.r)}${end}` })
    } else if (n.kind === 'pr') {
      const box = `<rect x="-6" y="-6" width="12" height="12" rx="3" fill="${C.bg}" stroke="${C.label}"/>`
      out.push({ id: n.id, layer: 0, markup: `${head}${under(box)}${box}${labelOf(n, C.muted, C.muted, 6)}${end}` })
    }
  }
  out.sort((a, b) => a.layer - b.layer || a.id.localeCompare(b.id))
  /** @type {{ id: string, group: 'hierarchy' | 'resource' | 'lineage' | 'lit', markup: string }[]} */
  const edgeParts = []
  for (const e of edges) {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (!a || !b) continue
    if (e.kind === 'lineage') {
      const isFamily = selected === e.from || selected === e.to || (isProjectFocus && lit.has(e.from) && lit.has(e.to))
      if (!isFamily && (tier < 2 || a.parent !== b.parent)) continue
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
      const back = sessionR(b, bucketOf(lookup.sessions.get(b.ref))) + 3
      const ex = b.x - ((b.x - a.x) / len) * back
      const ey = b.y - ((b.y - a.y) / len) * back
      edgeParts.push({ id: `lineage:${e.from}>${e.to}`, group: 'lineage', markup: `<g><line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(ex)}" y2="${f(ey)}" stroke-dasharray="5 4"/><circle cx="${f(ex)}" cy="${f(ey)}" r="2.5" fill="${C.bg}"/></g>` })
      continue
    }
    if (a.kind === 'session' && b.kind === 'worktree' && selected !== a.id && selected !== b.id) continue
    const group = lit.has(e.from) && lit.has(e.to) && (isProjectFocus || e.from === selected || e.to === selected) ? 'lit' : e.kind === 'resource' ? 'resource' : 'hierarchy'
    const edgeOpacity = group === 'lit' ? 1 : lit.size > 0 ? OUT_OF_FOCUS_EDGE_OPACITY : Math.min(opacityOf(a), opacityOf(b))
    const quiet = edgeOpacity < 1 ? ` opacity="${edgeOpacity}"` : ''
    edgeParts.push({ id: `${e.kind}:${e.from}>${e.to}`, group, markup: `<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}"${quiet}/>` })
  }
  return { nodes: out.map(({ id, markup }) => ({ id, markup })), edges: edgeParts, placement: new Map([...placed].map(([id, at]) => [id, at.spot])), labels: placed, unlabelledNeedsYou }
}

const OUT_OF_FOCUS_OPACITY = 0.32
const OUT_OF_FOCUS_EDGE_OPACITY = 0.28
const IDLE_OPACITY = 0.5

/** A sonar ping every 2 s: a ring leaves the node's edge, grows and fades out, easing as it goes. @param {number} r @param {string} stroke */
function sonar(r, stroke) {
  const ease = 'calcMode="spline" keyTimes="0;1" keySplines=".2 .6 .35 1" dur="2s" repeatCount="indefinite"'
  return `<circle class="sonar" r="${f(r + 2)}" fill="none" stroke="${stroke}" stroke-width="2" stroke-opacity="0" pointer-events="none"><animate attributeName="r" values="${f(r + 2)};${f(r + 24)}" ${ease}/><animate attributeName="stroke-opacity" values=".9;0" ${ease}/></circle>`
}

/** A looping SVG opacity pulse (1.15's, deepened and quickened in 2.2.3). @param {string} attribute @param {string} values @param {number} seconds */
function pulse(attribute, values, seconds) {
  return `<animate attributeName="${attribute}" values="${values}" dur="${seconds}s" repeatCount="indefinite"/>`
}

/** A hub's hexagon, centred on the origin, as SVG `points`. @param {number} r */
export function hexagonPoints(r) {
  const points = []
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI / 3) * i - Math.PI / 6
    points.push(`${f(Math.cos(a) * r)},${f(Math.sin(a) * r)}`)
  }
  return points.join(' ')
}

/** A PR node's label as `#18`. @param {string} label */
function prNumberOf(label) {
  return /^#\d+/.exec(label)?.[0] ?? label
}

/**
 * The "+N" pill on a node's upper right: the children it hides, past the
 * sub-agent limit or collapsed (1.15's `overflowPill`).
 * @param {GraphNode} node
 * @param {{ count: number, noun: string, reason?: string }} hidden
 * @param {number} scale
 * @param {Record<string, string>} C
 */
function overflowPillOf(node, hidden, scale, C) {
  const text = `+${hidden.count}`
  const h = 13 * scale
  const w = (9 + text.length * 5.6) * scale
  const x = node.r * 0.45
  const y = -node.r - h + 5
  return `<g class="more" data-expand="${escapeXml(node.id)}"><title>${escapeXml(`${plural(hidden.count, hidden.noun)} hidden (${hidden.reason === 'cap' ? 'sub-agent limit' : 'collapsed'})`)}</title><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${f(h / 2)}" fill="${C.bg3}" stroke="${C.controlEdge}" stroke-width="${f(scale)}"/><text x="${f(x + w / 2)}" y="${f(y + h * 0.72)}" text-anchor="middle" font-size="${f(9 * scale)}" font-weight="600" fill="${C.label}" stroke="none">${escapeXml(text)}</text></g>`
}

const DIRECTION = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } }
const MAX_ANGLE = Math.PI / 3

/**
 * The node nearest to `fromId` in a direction (within 60° of it), weighted
 * so a straighter one wins over a slightly closer one at an angle; null when
 * nothing lies that way.
 * @param {readonly { id: string, x: number, y: number }[]} nodes
 * @param {string} fromId
 * @param {'left' | 'right' | 'up' | 'down'} direction
 * @returns {string | null}
 */
export function nearestInDirection(nodes, fromId, direction) {
  const from = nodes.find(n => n.id === fromId)
  if (!from) return null
  const d = DIRECTION[direction]
  let best = null
  let bestScore = Infinity
  for (const n of nodes) {
    if (n.id === fromId) continue
    const dx = n.x - from.x
    const dy = n.y - from.y
    const dist = Math.hypot(dx, dy)
    if (dist === 0) continue
    const angle = Math.acos(Math.max(-1, Math.min(1, (dx * d.x + dy * d.y) / dist)))
    if (angle > MAX_ANGLE) continue
    const score = dist * (1 + (2 * angle) / Math.PI)
    if (score < bestScore) {
      best = n.id
      bestScore = score
    }
  }
  return best
}

/**
 * The keys of the sessions a search matches (title or project name,
 * case-insensitive), needs-you first, then in the order given.
 * @param {readonly SessionView[]} sessions
 * @param {string} query
 * @param {ReadonlyMap<string, { name: string }>} projects
 * @returns {string[]}
 */
export function searchMatches(sessions, query, projects) {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits = sessions.filter(s => s.title.toLowerCase().includes(q) || (projects.get(s.projectId)?.name ?? '').toLowerCase().includes(q))
  return [...hits.filter(s => bucketOf(s) === 'needs-you'), ...hits.filter(s => bucketOf(s) !== 'needs-you')].map(s => s.key)
}
