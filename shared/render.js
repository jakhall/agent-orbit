// @ts-check

import { PALETTE, PALETTE_LIGHT } from './constants.js'

/** @typedef {import('../types').GraphNode} GraphNode */
/** @typedef {import('../types').SessionView} SessionView */
/** @typedef {import('../types').AgentView} AgentView */
/** @typedef {import('../types').ProjectView} ProjectView */
/** @typedef {import('../types').WorktreeView} WorktreeView */
/** @typedef {import('../types').Snapshot} Snapshot */
/** @typedef {import('../types').Camera} Camera */
/** @typedef {{ x: number, y: number, w: number, h: number }} ViewBox */

/**
 * @typedef {object} Lookup
 * @property {Map<string, SessionView>} sessions
 * @property {Map<string, AgentView>} agents
 * @property {Map<string, ProjectView>} projects
 * @property {Map<string, WorktreeView>} worktrees
 */

/**
 * @param {Snapshot} snapshot
 * @returns {Lookup}
 */
export function lookupOf(snapshot) {
  return {
    sessions: new Map(snapshot.sessions.map(s => [s.key, s])),
    agents: new Map(snapshot.agents.map(a => [a.key, a])),
    projects: new Map(snapshot.projects.map(p => [p.id, p])),
    worktrees: new Map(snapshot.worktrees.map(w => [w.id, w])),
  }
}

/**
 * The world-space box a node and its label take up.
 * @param {GraphNode} n
 * @param {number} labelScale
 * @returns {{ minX: number, maxX: number, minY: number, maxY: number }}
 */
function extentOf(n, labelScale) {
  const labelRoom = (n.kind === 'session' ? 175 : n.kind === 'project' ? 80 : n.kind === 'agent' ? 30 : 60) * labelScale
  return {
    minX: n.x - n.r - (n.side < 0 || n.kind === 'project' ? labelRoom : 20),
    maxX: n.x + n.r + (n.side > 0 || n.kind === 'project' ? labelRoom : 20),
    minY: n.y - n.r - 20,
    maxY: n.y + n.r + (n.kind === 'project' ? 40 : 24) * labelScale,
  }
}

/**
 * Re-packs whole project clusters into the grid (in reading order) that
 * draws largest in a box of `aspect` (width / height), so a tall narrow pane
 * shows them at a legible scale. Each cluster moves as one, so nothing moves
 * inside it.
 * @param {GraphNode[]} nodes
 * @param {number} aspect
 * @param {number} [labelScale]
 * @returns {GraphNode[]}
 */
export function stackClusters(nodes, aspect, labelScale = 1) {
  const byId = new Map(nodes.map(n => [n.id, n]))
  /** @param {GraphNode} node */
  const rootOf = node => {
    let current = node
    for (let depth = 0; depth < 8 && current.parent; depth += 1) {
      const parent = byId.get(current.parent)
      if (!parent) break
      current = parent
    }
    return current
  }
  /** @type {Map<string, { root: GraphNode, minX: number, maxX: number, minY: number, maxY: number }>} */
  const clusters = new Map()
  /** @type {Map<string, string>} */
  const clusterOf = new Map()
  for (const n of nodes) {
    const root = rootOf(n)
    const e = extentOf(n, labelScale)
    const c = clusters.get(root.id) ?? { root, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
    c.minX = Math.min(c.minX, e.minX)
    c.maxX = Math.max(c.maxX, e.maxX)
    c.minY = Math.min(c.minY, e.minY)
    c.maxY = Math.max(c.maxY, e.maxY)
    clusters.set(root.id, c)
    clusterOf.set(n.id, root.id)
  }
  const ordered = [...clusters.values()].sort((a, b) => a.root.y - b.root.y || a.root.x - b.root.x)
  const gap = 60
  /** @param {number} cols */
  const pack = cols => {
    /** @type {Map<string, { dx: number, dy: number }>} */
    const shift = new Map()
    let top = 0
    let width = 0
    for (let i = 0; i < ordered.length; i += cols) {
      const row = ordered.slice(i, i + cols)
      let left = 0
      let height = 0
      for (const c of row) {
        shift.set(c.root.id, { dx: left - c.minX, dy: top - c.minY })
        left += c.maxX - c.minX + gap
        height = Math.max(height, c.maxY - c.minY)
      }
      width = Math.max(width, left - gap)
      top += height + gap
    }
    return { shift, width, height: top - gap }
  }
  let best = pack(1)
  for (let cols = 2; cols <= ordered.length; cols += 1) {
    const next = pack(cols)
    if (Math.max(next.width, next.height * aspect) < Math.max(best.width, best.height * aspect)) best = next
  }
  return nodes.map(n => {
    const s = best.shift.get(clusterOf.get(n.id) ?? '') ?? { dx: 0, dy: 0 }
    return { ...n, x: n.x + s.dx, y: n.y + s.dy }
  })
}

/**
 * The view box that fits `nodes` at `aspect` (width / height), moved by the camera.
 * @param {GraphNode[]} nodes
 * @param {number} aspect
 * @param {Camera} camera
 * @param {number} [labelScale]
 * @returns {ViewBox}
 */
export function viewBoxFor(nodes, aspect, camera, labelScale = 1) {
  if (nodes.length === 0) return { x: -400, y: -300, w: 800, h: 600 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    const e = extentOf(n, labelScale)
    minX = Math.min(minX, e.minX)
    maxX = Math.max(maxX, e.maxX)
    minY = Math.min(minY, e.minY)
    maxY = Math.max(maxY, e.maxY)
  }
  let w = Math.max(240, maxX - minX)
  let h = Math.max(180, maxY - minY)
  if (w / h > aspect) h = w / aspect
  else w = h * aspect
  const cx = (minX + maxX) / 2 + camera.panX * w
  const cy = (minY + maxY) / 2 + camera.panY * h
  const zoom = Math.min(8, Math.max(0.25, camera.zoom))
  const zw = w / zoom
  const zh = h / zoom
  return { x: cx - zw / 2, y: cy - zh / 2, w: zw, h: zh }
}

/**
 * A PR node's label as `#18`, also from older snapshots that added the state word.
 * @param {string} label
 * @returns {string}
 */
export function prNumber(label) {
  return /^#\d+/.exec(label)?.[0] ?? label
}

/**
 * The node nearest to a world point within its hit radius, sessions and agents first.
 * @param {GraphNode[]} nodes
 * @param {number} x
 * @param {number} y
 * @param {number} slack
 * @returns {GraphNode | null}
 */
export function hitTest(nodes, x, y, slack) {
  let best = null
  let bestScore = Infinity
  for (const n of nodes) {
    const d = Math.hypot(n.x - x, n.y - y)
    if (d > n.r + slack) continue
    const score = d - (n.kind === 'agent' ? 4 : 0)
    if (score < bestScore) {
      best = n
      bestScore = score
    }
  }
  return best
}

const cssName = (/** @type {string} */ key) => `--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`
const VAR_OF_HEX = new Map(
  Object.entries(PALETTE)
    .reverse()
    .map(([key, hex]) => [hex.toUpperCase(), `var(${cssName(key)})`]),
)

/**
 * Markup or a colour with every palette colour swapped for its CSS variable,
 * so it follows the page's theme. A value two keys share keeps the first key.
 * @param {string} text
 * @returns {string}
 */
export function paletteVars(text) {
  return String(text).replace(/#[0-9A-Fa-f]{6}\b/g, hex => VAR_OF_HEX.get(hex.toUpperCase()) ?? hex)
}

/**
 * The light theme's variables: under the system's light setting unless the
 * window chose dark, and whenever the window chose light.
 * @returns {string}
 */
export function lightThemeCss() {
  const vars = Object.entries(PALETTE_LIGHT)
    .map(([key, hex]) => `${cssName(key)}:${hex}`)
    .join(';')
  return `@media (prefers-color-scheme: light){:root:not([data-theme='dark']){${vars};color-scheme:light}}:root[data-theme='light']{${vars};color-scheme:light}`
}

/**
 * Where a node dragged to (`x`, `y`) is saved in `prefs.positions`, as 1.15
 * saved it: a hub at its own place, anything else as an offset from its
 * parent, so it moves with the parent afterwards.
 * @param {{ parent: string | null }} node
 * @param {number} x
 * @param {number} y
 * @param {readonly { id: string, x: number, y: number }[]} nodes
 * @returns {{ dx: number, dy: number }}
 */
export function offsetFor(node, x, y, nodes) {
  const parent = node.parent ? nodes.find(n => n.id === node.parent) : undefined
  return parent ? { dx: x - parent.x, dy: y - parent.y } : { dx: x, dy: y }
}
