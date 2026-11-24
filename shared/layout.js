// @ts-check

import { hash } from './format.js'

/** @typedef {import('../types').AgentView} AgentView */
/** @typedef {import('../types').GraphEdge} GraphEdge */
/** @typedef {import('../types').GraphNode} GraphNode */
/** @typedef {import('../types').Offset} Offset */
/** @typedef {import('../types').ProjectView} ProjectView */
/** @typedef {import('../types').SessionView} SessionView */
/** @typedef {import('../types').WorktreeView} WorktreeView */

const RING_RADII = [150, 235, 320, 405, 490]
const RING_CAPS = [10, 16, 22, 28, 34]
const AGENT_RADIUS = 68
const AGENT_STEP = 30
const AGENT_ARC = 7
const AGENT_ANGLE = 0.4
const PR_RADIUS = 110
const CLUSTER_MARGIN = 80

/**
 * @typedef {object} LayoutInput
 * @property {ProjectView[]} projects
 * @property {WorktreeView[]} worktrees
 * @property {SessionView[]} sessions
 * @property {AgentView[]} agents
 */

/** @typedef {{ project: ProjectView, sessions: { session: SessionView, dx: number, dy: number }[], radius: number }} Cluster */

/**
 * @param {string} path
 * @returns {string}
 */
function basename(path) {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? path
}

/**
 * @param {number} count
 * @returns {{ ring: number, cap: number }[]}
 */
function ringSlots(count) {
  /** @type {{ ring: number, cap: number }[]} */
  const rings = []
  let left = count
  for (let ring = 0; left > 0; ring += 1) {
    const cap = RING_CAPS[ring] ?? (RING_CAPS.at(-1) ?? 34) + 6 * (ring - RING_CAPS.length + 1)
    rings.push({ ring, cap })
    left -= cap
  }
  return rings
}

/**
 * @param {number} ring
 * @returns {number}
 */
function ringRadius(ring) {
  return RING_RADII[ring] ?? (RING_RADII.at(-1) ?? 490) + 85 * (ring - RING_RADII.length + 1)
}

/**
 * Dragged hubs exactly where they were dropped: the person decides, so two
 * dragged clusters may overlap. Only computed slots keep clear of them.
 * @param {Cluster[]} clusters in layout order
 * @param {Record<string, Offset>} positions
 * @returns {{ id: string, x: number, y: number, radius: number }[]}
 */
function draggedHubs(clusters, positions) {
  return clusters.flatMap(cluster => {
    const at = positions[`p:${cluster.project.id}`]
    return at ? [{ id: cluster.project.id, x: at.dx, y: at.dy, radius: cluster.radius }] : []
  })
}

/**
 * Deterministic placement: project clusters packed in rows in order of their
 * oldest session, sessions on rings around their project in hashed slots
 * (probing to the next free slot), subagents on an arc of spokes facing away from the hub,
 * and a lineage edge from each session's parent session when both are shown.
 * Positions depend on identity and age, never on status. A dragged node's
 * offset from its parent, from prefs, replaces the computed one; a dragged
 * hub stays where it was dropped and computed slots skip the clusters it covers. With
 * `pack` (2.1), those projects take the first grid slots, sized as if they
 * were the only ones, and the rest follow, so the map fits what is shown.
 * @param {LayoutInput} input
 * @param {Record<string, Offset>} positions
 * @param {{ pack?: ReadonlySet<string> }} [options]
 * @returns {{ nodes: GraphNode[], edges: GraphEdge[] }}
 */
export function layoutGraph(input, positions, options = {}) {
  const pack = options.pack
  /** @type {GraphNode[]} */
  const nodes = []
  /** @type {GraphEdge[]} */
  const edges = []
  /** @type {Map<string, SessionView[]>} */
  const sessionsByProject = new Map()
  for (const s of input.sessions) {
    const list = sessionsByProject.get(s.projectId) ?? []
    list.push(s)
    sessionsByProject.set(s.projectId, list)
  }
  /** @type {Map<string, AgentView[]>} */
  const agentsBySession = new Map()
  for (const a of input.agents) {
    const list = agentsBySession.get(a.sessionKey) ?? []
    list.push(a)
    agentsBySession.set(a.sessionKey, list)
  }
  const age = (/** @type {SessionView} */ s) => s.createdAt ?? s.lastActivityAt
  const projects = [...input.projects]
    .filter(p => (sessionsByProject.get(p.id) ?? []).length > 0)
    .map(p => ({ project: p, oldest: Math.min(...(sessionsByProject.get(p.id) ?? []).map(age)) }))
    .sort((a, b) => (pack ? Number(pack.has(b.project.id)) - Number(pack.has(a.project.id)) : 0) || a.oldest - b.oldest || a.project.id.localeCompare(b.project.id))
    .map(p => p.project)

  /** @type {Cluster[]} */
  const clusters = []
  for (const project of projects) {
    const sessions = [...(sessionsByProject.get(project.id) ?? [])].sort((a, b) => age(a) - age(b) || a.key.localeCompare(b.key))
    const rings = ringSlots(sessions.length)
    const taken = rings.map(r => /** @type {boolean[]} */ (new Array(r.cap).fill(false)))
    const offset = ((hash(project.id) % 360) * Math.PI) / 180
    /** @type {Cluster['sessions']} */
    const placed = []
    let outer = 0
    for (const session of sessions) {
      for (const { ring, cap } of rings) {
        const slots = taken[ring]
        if (!slots || slots.every(Boolean)) continue
        let slot = hash(session.key) % cap
        while (slots[slot]) slot = (slot + 1) % cap
        slots[slot] = true
        const angle = offset + ring * 0.31 + (slot * 2 * Math.PI) / cap
        const radius = ringRadius(ring)
        outer = Math.max(outer, radius)
        placed.push({ session, dx: Math.cos(angle) * radius, dy: Math.sin(angle) * radius })
        break
      }
    }
    clusters.push({ project, sessions: placed, radius: Math.max(120, outer + CLUSTER_MARGIN) })
  }

  const gap = 160
  const labelRoom = 220
  const packed = pack && clusters.some(c => pack.has(c.project.id)) ? clusters.filter(c => pack.has(c.project.id)) : clusters
  const area = packed.reduce((sum, c) => sum + (2 * c.radius + labelRoom + gap) * (2 * c.radius + gap), 0)
  const rowWidth = Math.max(1400, Math.sqrt(area) * 1.6)
  /** @type {{ x: number, y: number }[]} */
  const centres = []
  let cursorX = 0
  let cursorY = 0
  let rowHeight = 0
  const dragged = draggedHubs(clusters, positions)
  for (const cluster of clusters) {
    const width = 2 * cluster.radius + labelRoom
    const pinnedAt = dragged.find(d => d.id === cluster.project.id)
    if (pinnedAt) {
      centres.push({ x: pinnedAt.x, y: pinnedAt.y })
      continue
    }
    for (let tries = 0; ; tries += 1) {
      if (cursorX > 0 && cursorX + width > rowWidth) {
        cursorX = 0
        cursorY += rowHeight + gap
        rowHeight = 0
      }
      const centre = { x: cursorX + cluster.radius + labelRoom / 2, y: cursorY + cluster.radius }
      cursorX += width + gap
      rowHeight = Math.max(rowHeight, 2 * cluster.radius)
      const isFree = tries >= 50 || dragged.every(d => Math.hypot(d.x - centre.x, d.y - centre.y) >= d.radius + cluster.radius)
      if (isFree) {
        centres.push(centre)
        break
      }
    }
  }

  clusters.forEach((cluster, index) => {
    const { project } = cluster
    const projectId = `p:${project.id}`
    const centre = centres[index] ?? { x: 0, y: 0 }
    const px = centre.x
    const py = centre.y
    nodes.push({ id: projectId, kind: 'project', ref: project.id, parent: null, x: px, y: py, r: 30, label: project.name, side: 1 })

    const worktreeIds = project.worktreeIds
    worktreeIds.forEach(worktreeId => {
      const worktree = input.worktrees.find(w => w.id === worktreeId)
      if (!worktree) return
      const id = `w:${worktree.id}`
      const angle = ((hash(worktree.id) % 360) * Math.PI) / 180
      const pinned = positions[id]
      const dx = pinned ? pinned.dx : Math.cos(angle) * 78
      const dy = pinned ? pinned.dy : Math.sin(angle) * 78
      nodes.push({
        id,
        kind: 'worktree',
        ref: worktree.id,
        parent: projectId,
        x: px + dx,
        y: py + dy,
        r: 8,
        label: worktree.branch ?? basename(worktree.path),
        side: 1,
      })
      edges.push({ from: projectId, to: id, kind: 'resource' })
    })

    for (const { session, dx: baseDx, dy: baseDy } of cluster.sessions) {
      const id = `s:${session.key}`
      const pinned = positions[id]
      const dx = pinned ? pinned.dx : baseDx
      const dy = pinned ? pinned.dy : baseDy
      const sx = px + dx
      const sy = py + dy
      /** @type {1 | -1} */
      const side = dx >= 0 ? 1 : -1
      nodes.push({ id, kind: 'session', ref: session.key, parent: projectId, x: sx, y: sy, r: 15, label: session.title, side })
      edges.push({ from: projectId, to: id, kind: 'hierarchy' })
      if (session.worktreeId && worktreeIds.includes(session.worktreeId)) {
        edges.push({ from: id, to: `w:${session.worktreeId}`, kind: 'resource' })
      }

      const outward = Math.atan2(baseDy, baseDx)
      const agents = [...(agentsBySession.get(session.key) ?? [])].sort(
        (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.key.localeCompare(b.key),
      )
      const fan = agentFan(agents, outward)
      const prRadius = Math.max(PR_RADIUS, ...[...fan.values()].map(at => at.radius + 28))
      agents.forEach(agent => {
        const at = /** @type {{ angle: number, radius: number }} */ (fan.get(agent.key))
        const aid = `a:${agent.key}`
        const pinnedAgent = positions[aid]
        const adx = pinnedAgent ? pinnedAgent.dx : Math.cos(at.angle) * at.radius
        const ady = pinnedAgent ? pinnedAgent.dy : Math.sin(at.angle) * at.radius
        nodes.push({
          id: aid,
          kind: 'agent',
          ref: agent.key,
          parent: id,
          x: sx + adx,
          y: sy + ady,
          r: 6,
          label: agent.description || agent.type,
          side: adx >= 0 ? 1 : -1,
        })
        const parentAgent = agent.parentKey ? `a:${agent.parentKey}` : null
        const hasParent = parentAgent !== null && agents.some(a => `a:${a.key}` === parentAgent)
        edges.push({ from: hasParent && parentAgent ? parentAgent : id, to: aid, kind: 'hierarchy' })
      })

      session.prs.slice(0, 6).forEach((pr, i) => {
        const pid = `pr:${session.key}#${pr.number}`
        const angle = outward + (i - (Math.min(6, session.prs.length) - 1) / 2) * 0.35
        const pinnedPr = positions[pid]
        const pdx = pinnedPr ? pinnedPr.dx : Math.cos(angle) * prRadius
        const pdy = pinnedPr ? pinnedPr.dy : Math.sin(angle) * prRadius
        nodes.push({ id: pid, kind: 'pr', ref: pr.url, parent: id, x: sx + pdx, y: sy + pdy, r: 6, label: `#${pr.number}`, side: 1 })
        edges.push({ from: id, to: pid, kind: 'resource' })
      })
    }
  })

  const sessionIds = new Set(nodes.filter(n => n.kind === 'session').map(n => n.id))
  for (const session of [...input.sessions].sort((a, b) => a.key.localeCompare(b.key))) {
    const parent = /** @type {{ parent?: { key: string } | null }} */ (/** @type {unknown} */ (session)).parent
    if (!parent || parent.key === session.key) continue
    const from = `s:${parent.key}`
    const to = `s:${session.key}`
    if (sessionIds.has(from) && sessionIds.has(to)) edges.push({ from, to, kind: 'lineage' })
  }
  return { nodes, edges }
}

/**
 * Where each of a session's subagents sits, as an angle and a distance from
 * the session: long spokes of equal length on one arc, `AGENT_ANGLE` apart and
 * centred on `outward` (away from the hub). Top-level agents, oldest first,
 * fill it up to `AGENT_ARC` (about 140 degrees); more start a further arc
 * `AGENT_STEP` out, turned half a spoke when its spokes would line up with
 * the arc before's. An agent started by another agent extends its parent's
 * spoke one step out.
 * @param {readonly AgentView[]} agents oldest first
 * @param {number} outward radians
 * @returns {Map<string, { angle: number, radius: number }>}
 */
export function agentFan(agents, outward) {
  const keys = new Set(agents.map(a => a.key))
  const isRoot = (/** @type {AgentView} */ a) => !a.parentKey || !keys.has(a.parentKey) || a.parentKey === a.key
  const roots = agents.filter(isRoot)
  /** @type {Map<string, { angle: number, radius: number }>} */
  const out = new Map()
  let placed = 0
  let previousTurn = 0
  /** @type {number | null} */
  let previousCount = null
  for (let row = 0; placed < roots.length; row += 1) {
    const radius = AGENT_RADIUS + row * AGENT_STEP
    const count = Math.min(AGENT_ARC, roots.length - placed)
    const aligned = previousCount !== null && previousCount % 2 === count % 2
    const turn = aligned ? (previousTurn === 0 ? AGENT_ANGLE / 2 : 0) : previousTurn
    for (let j = 0; j < count; j += 1) {
      const agent = /** @type {AgentView} */ (roots[placed + j])
      out.set(agent.key, { angle: outward + (j - (count - 1) / 2) * AGENT_ANGLE + turn, radius })
    }
    placed += count
    previousCount = count
    previousTurn = turn
  }
  /** @type {Map<string, AgentView[]>} */
  const children = new Map()
  for (const a of agents) {
    if (isRoot(a)) continue
    const list = children.get(/** @type {string} */ (a.parentKey)) ?? []
    list.push(a)
    children.set(/** @type {string} */ (a.parentKey), list)
  }
  /** @param {string} key */
  const extend = key => {
    const from = out.get(key)
    const list = children.get(key) ?? []
    list.forEach((child, j) => {
      if (!from || out.has(child.key)) return
      const radius = from.radius + AGENT_STEP
      out.set(child.key, { angle: from.angle + (j - (list.length - 1) / 2) * (AGENT_ANGLE / 2), radius })
      extend(child.key)
    })
  }
  for (const root of roots) extend(root.key)
  for (const a of agents) if (!out.has(a.key)) out.set(a.key, { angle: outward, radius: AGENT_RADIUS })
  return out
}
