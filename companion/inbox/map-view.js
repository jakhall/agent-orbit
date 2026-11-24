import { PALETTE } from '/shared/constants.js'
import { planPatch } from '/shared/map.js'
import { paletteVars } from '/shared/render.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const EDGE_GROUPS = ['hierarchy', 'resource', 'lineage', 'lit']

/**
 * Moves each label icon placed from an estimated text width (labels anchored
 * at their end or middle) to sit just before the text as drawn, so the text
 * itself keeps the exact spot its leader line points at.
 * @param {(Element | undefined)[]} elements
 */
export function fitIcons(elements) {
  const icons = elements.flatMap(element => (element ? [...element.querySelectorAll('.kind-icon[data-fit]')] : []))
  const moves = icons.map(icon => {
    const text = icon.nextElementSibling
    const width = text && typeof text.getComputedTextLength === 'function' ? text.getComputedTextLength() : 0
    if (!(width > 0)) return null
    const x = Number(text.getAttribute('x'))
    const left = icon.getAttribute('data-fit') === 'end' ? x - width : x - width / 2
    return { icon, x: left - Number(icon.getAttribute('data-gap')) }
  })
  for (const move of moves) {
    if (!move) continue
    const transform = move.icon.getAttribute('transform') ?? ''
    move.icon.setAttribute('transform', transform.replace(/translate\(([^ )]+)/, `translate(${Math.round(move.x * 100) / 100}`))
  }
}

/**
 * The map as a retained SVG: one element per node and per edge, keyed by id,
 * patched in place so a small change touches only its own elements.
 */
export function createMapView() {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('font-family', 'Segoe UI Variable Text, Segoe UI, system-ui, sans-serif')
  const edgeRoot = document.createElementNS(SVG_NS, 'g')
  edgeRoot.setAttribute('class', 'edges')
  const groups = {}
  for (const name of EDGE_GROUPS) {
    const g = document.createElementNS(SVG_NS, 'g')
    g.setAttribute('stroke', paletteVars(name === 'lit' ? PALETTE.accent : name === 'lineage' ? PALETTE.muted : PALETTE.lineStrong))
    g.setAttribute('stroke-width', name === 'lit' ? '2' : '1')
    if (name === 'resource') g.setAttribute('stroke-dasharray', '3 4')
    edgeRoot.append(g)
    groups[name] = g
  }
  const nodeRoot = document.createElementNS(SVG_NS, 'g')
  nodeRoot.setAttribute('class', 'nodes')
  nodeRoot.setAttribute('fill', paletteVars(PALETTE.surface))
  nodeRoot.setAttribute('stroke-width', '1.6')
  svg.append(edgeRoot, nodeRoot)
  const parser = document.createElementNS(SVG_NS, 'svg')
  const nodes = { markup: new Map(), el: new Map() }
  const edges = { markup: new Map(), el: new Map(), group: new Map() }
  const stats = { touched: 0, ms: 0, updates: 0 }

  const parse = markup => {
    parser.innerHTML = markup
    return parser.firstElementChild
  }

  const patchNodes = parts => {
    const plan = planPatch(nodes.markup, parts)
    for (const id of plan.remove) {
      nodes.el.get(id)?.remove()
      nodes.el.delete(id)
      nodes.markup.delete(id)
    }
    const fresh = new Set([...plan.add, ...plan.replace])
    for (const part of parts) {
      if (!fresh.has(part.id)) continue
      const next = parse(part.markup)
      const title = next.querySelector(':scope > title')
      if (title) {
        next.setAttribute('aria-label', title.textContent.replace(/\n/g, ' · '))
        title.remove()
      }
      const old = nodes.el.get(part.id)
      if (old) old.replaceWith(next)
      else nodeRoot.append(next)
      nodes.el.set(part.id, next)
      nodes.markup.set(part.id, part.markup)
    }
    if (plan.isReordered || plan.add.length > 0) {
      const wanted = parts.map(p => nodes.el.get(p.id))
      if (wanted.some((element, i) => nodeRoot.children[i] !== element)) nodeRoot.replaceChildren(...wanted)
    }
    fitIcons([...fresh].map(id => nodes.el.get(id)))
    return plan.remove.length + fresh.size
  }

  const patchEdges = parts => {
    const plan = planPatch(edges.markup, parts.map(p => ({ id: p.id, markup: `${p.group}|${p.markup}` })))
    for (const id of plan.remove) {
      edges.el.get(id)?.remove()
      edges.el.delete(id)
      edges.markup.delete(id)
    }
    const fresh = new Set([...plan.add, ...plan.replace])
    for (const part of parts) {
      if (!fresh.has(part.id)) continue
      const next = parse(part.markup)
      edges.el.get(part.id)?.remove()
      groups[part.group].append(next)
      edges.el.set(part.id, next)
      edges.markup.set(part.id, `${part.group}|${part.markup}`)
    }
    return plan.remove.length + fresh.size
  }

  let drawn = null
  const themeCache = new Map()
  const edgeEnds = id => {
    const at = id.indexOf(':')
    const arrow = id.lastIndexOf('>')
    return at < 0 || arrow < at ? null : { from: id.slice(at + 1, arrow), to: id.slice(arrow + 1) }
  }
  const num = (element, name) => Number(element.getAttribute(name))
  return {
    element: svg,
    stats,
    markupOf: id => nodes.markup.get(id),
    setViewBox(c) {
      drawn = c
      svg.style.transform = ''
      svg.classList.remove('is-moving')
      svg.setAttribute('viewBox', `${c.x} ${c.y} ${c.w} ${c.h}`)
    },
    /** Shows camera `c` during a gesture by transforming the drawn map (compositor only, no layout); `setViewBox` commits it. */
    preview(c) {
      if (!drawn) return this.setViewBox(c)
      const k = svg.clientWidth / drawn.w
      const s = drawn.w / c.w
      svg.classList.add('is-moving')
      svg.style.transform = `translate(${(drawn.x - c.x) * k * s}px, ${(drawn.y - c.y) * k * s}px) scale(${s})`
    },
    /**
     * Starts a node drag (1.15's live drag): finds, once, the drawn nodes in
     * `ids` and the lines touching them, with their drawn places. The handle
     * goes to `moveGroup` and `endMove`.
     * @param {ReadonlySet<string>} ids
     * @param {ReadonlyMap<string, { x: number, y: number }>} at each node's laid-out place
     */
    beginMove(ids, at) {
      const moved = []
      for (const id of ids) {
        const n = at.get(id)
        const element = nodes.el.get(id)
        if (n && element) moved.push({ element, x: n.x, y: n.y })
      }
      const lines = []
      for (const [id, element] of edges.el) {
        const ends = edgeEnds(id)
        if (!ends) continue
        const moveFrom = ids.has(ends.from)
        const moveTo = ids.has(ends.to)
        if (!moveFrom && !moveTo) continue
        const line = element.tagName === 'line' ? element : element.querySelector('line')
        const dot = element.tagName === 'line' ? null : element.querySelector('circle')
        if (!line) continue
        lines.push({ id, line, dot, moveFrom, moveTo, x1: num(line, 'x1'), y1: num(line, 'y1'), x2: num(line, 'x2'), y2: num(line, 'y2'), cx: dot ? num(dot, 'cx') : 0, cy: dot ? num(dot, 'cy') : 0 })
      }
      return { ids, moved, lines }
    },
    /** Moves a started drag's nodes and line ends by (`dx`, `dy`) world units from where they were drawn. */
    moveGroup(handle, dx, dy) {
      for (const m of handle.moved) m.element.setAttribute('transform', `translate(${m.x + dx} ${m.y + dy})`)
      for (const l of handle.lines) {
        if (l.moveFrom) {
          l.line.setAttribute('x1', String(l.x1 + dx))
          l.line.setAttribute('y1', String(l.y1 + dy))
        }
        if (l.moveTo) {
          l.line.setAttribute('x2', String(l.x2 + dx))
          l.line.setAttribute('y2', String(l.y2 + dy))
          l.dot?.setAttribute('cx', String(l.cx + dx))
          l.dot?.setAttribute('cy', String(l.cy + dy))
        }
      }
    },
    /** Ends a node drag: the next `update` redraws (or removes) every moved node and line, wherever they were left. */
    endMove(handle) {
      for (const id of handle.ids) if (nodes.markup.has(id)) nodes.markup.set(id, '')
      for (const l of handle.lines) if (edges.markup.has(l.id)) edges.markup.set(l.id, '')
    },
    /** Draws the graph, touching only the nodes and edges whose markup changed. Returns how many elements it touched. */
    update(parts, camera) {
      const started = performance.now()
      if (themeCache.size > 6000) themeCache.clear()
      const theme = raw => {
        let out = themeCache.get(raw)
        if (out === undefined) themeCache.set(raw, (out = paletteVars(raw)))
        return out
      }
      const themed = list => list.map(p => ({ ...p, markup: theme(p.markup) }))
      this.setViewBox(camera)
      const touched = patchEdges(themed(parts.edges)) + patchNodes(themed(parts.nodes))
      stats.touched = touched
      stats.ms = performance.now() - started
      stats.updates += 1
      return touched
    },
  }
}
