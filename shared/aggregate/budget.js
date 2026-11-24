// @ts-check

/** @typedef {import('../../types').SnapshotV2} SnapshotV2 */
/** @typedef {import('../../types').AgentView} AgentView */

/** Readers refuse files over 4 MiB. */
export const SNAPSHOT_MAX_BYTES = 3.5 * 1024 * 1024

/** @type {readonly string[]} */
const FINISHED = ['completed', 'failed', 'interrupted', 'disconnected', 'stale', 'unknown', 'idle']

const sizeOf = (/** @type {unknown} */ value) => JSON.stringify(value).length + 1
const ageOf = (/** @type {{ lastActivityAt: number | null }} */ item) => item.lastActivityAt ?? 0

/**
 * Keeps the snapshot under `maxBytes`: drops finished sub-agents, oldest
 * first, then the oldest sessions that do not need the person, with their
 * sub-agents, and records the counts in `sources.budget`. A snapshot already
 * under budget is returned as it is.
 * @template {SnapshotV2} T
 * @param {T} snapshot
 * @param {number} maxBytes
 * @returns {T}
 */
export function budgetSnapshot(snapshot, maxBytes) {
  const total = sizeOf(snapshot)
  if (total <= maxBytes) return snapshot
  const agentsByAge = snapshot.agents.filter(a => FINISHED.includes(a.lifecycle)).sort((a, b) => ageOf(a) - ageOf(b))
  const sessionsByAge = snapshot.sessions.filter(s => s.attention === null && s.status?.bucket !== 'needs-you').sort((a, b) => ageOf(a) - ageOf(b))
  let target = total - maxBytes
  let result = snapshot
  for (let pass = 0; pass < 4; pass += 1) {
    let excess = target
    /** @type {Set<string>} */
    const droppedAgents = new Set()
    for (const agent of agentsByAge) {
      if (excess <= 0) break
      droppedAgents.add(agent.key)
      excess -= sizeOf(agent) + agent.key.length + 3
    }
    /** @type {Set<string>} */
    const droppedSessions = new Set()
    for (const session of sessionsByAge) {
      if (excess <= 0) break
      droppedSessions.add(session.key)
      excess -= sizeOf(session)
      for (const agent of snapshot.agents) {
        if (agent.sessionKey !== session.key || droppedAgents.has(agent.key)) continue
        droppedAgents.add(agent.key)
        excess -= sizeOf(agent)
      }
    }
    const trimmed = without(snapshot, droppedSessions, droppedAgents)
    result = { ...trimmed, sources: { ...trimmed.sources, budget: { maxBytes, droppedAgents: droppedAgents.size, droppedSessions: droppedSessions.size } } }
    const over = sizeOf(result) - maxBytes
    if (over <= 0) break
    target += over
  }
  return result
}

/**
 * @template {SnapshotV2} T
 * @param {T} snapshot
 * @param {ReadonlySet<string>} sessions
 * @param {ReadonlySet<string>} agents
 * @returns {T}
 */
function without(snapshot, sessions, agents) {
  return {
    ...snapshot,
    sessions: snapshot.sessions.filter(s => !sessions.has(s.key)).map(s => ({ ...s, agentKeys: s.agentKeys.filter(k => !agents.has(k)) })),
    agents: snapshot.agents.filter(a => !agents.has(a.key) && !sessions.has(a.sessionKey)),
    projects: snapshot.projects.map(p => ({ ...p, sessionKeys: p.sessionKeys.filter(k => !sessions.has(k)) })),
    worktrees: snapshot.worktrees.map(w => ({ ...w, sessionKeys: w.sessionKeys.filter(k => !sessions.has(k)) })),
  }
}
