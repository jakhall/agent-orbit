// @ts-check
import { layoutGraph } from './layout.js'

/** @typedef {import('../types').SnapshotV2} SnapshotV2 */
/** @typedef {import('../types').Snapshot} Snapshot */
/** @typedef {import('../types').Offset} Offset */

/**
 * What a pane or page draws: the server's schema 2 snapshot plus the graph
 * laid out for this reader's dragged positions, and how long that took.
 * `tier` (C10, `tierFor` in `shared/map.js`): below 2 (detail) the sub-agent
 * satellites and their edges are left out; every other node keeps the
 * position the full layout gives it. `pack` (2.1, `packedProjects` in
 * `shared/filters.js`): the projects laid out first, so Fit frames what is shown.
 * @param {SnapshotV2} snapshot
 * @param {Record<string, Offset>} positions
 * @param {{ tier?: 0 | 1 | 2, pack?: ReadonlySet<string> }} [options]
 * @returns {Snapshot}
 */
export function withGraph(snapshot, positions, options = {}) {
  const started = Date.now()
  const full = layoutGraph({ projects: snapshot.projects, worktrees: snapshot.worktrees, sessions: snapshot.sessions, agents: snapshot.agents }, positions, { pack: options.pack })
  const tier = options.tier ?? 2
  let graph = full
  if (tier < 2) {
    const nodes = full.nodes.filter(n => n.kind !== 'agent')
    const ids = new Set(nodes.map(n => n.id))
    graph = { nodes, edges: full.edges.filter(e => ids.has(e.from) && ids.has(e.to)) }
  }
  return { ...snapshot, graph, timings: { ...snapshot.timings, layoutMs: Date.now() - started } }
}
