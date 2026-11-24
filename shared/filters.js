// @ts-check

import { ACTIVE_LIFECYCLES, ATTENTION, LIFECYCLE, TIME_PRESETS } from './constants.js'

/** @typedef {import('../types').Snapshot} Snapshot */
/** @typedef {import('../types').SessionView} SessionView */
/** @typedef {import('../types').AgentView} AgentView */
/** @typedef {import('../types').GraphNode} GraphNode */
/** @typedef {import('../types').GraphEdge} GraphEdge */
/** @typedef {import('../types').Filters} Filters */
/** @typedef {import('../types').Settings} Settings */
/** @typedef {import('../types').ProjectView} ProjectView */

/**
 * @typedef {object} VisibleView
 * @property {SessionView[]} sessions
 * @property {GraphNode[]} nodes
 * @property {GraphEdge[]} edges
 * @property {SessionView[]} attention every session waiting on you, whatever the project or search filter
 * @property {SessionView[]} pinned pinned sessions, whatever the filters, newest first
 * @property {Record<string, SessionView[]>} peers for each active session, the other active sessions in the same checkout
 * @property {Record<string, Overflow>} overflow children a node hides, by node id: past the subagent cap, or collapsed
 * @property {Record<string, { sessions: number, running: number }>} projectCounts
 * @property {{ sessions: number, running: number, attention: number, agentsRunning: number }} counts
 * @property {{ value: string, label: string }[]} projectOptions
 * @property {{ value: string, label: string }[]} modelOptions
 * @property {number} hiddenCount sessions the filters (or a pin) would show that are hidden until active
 */

/** @typedef {import('../types').VisibleOptions} VisibleOptions */

/**
 * @typedef {object} Overflow
 * @property {number} count
 * @property {'cap' | 'collapsed'} reason
 * @property {'session' | 'subagent'} noun what is hidden
 */

/**
 * @param {SessionView} session
 * @returns {boolean}
 */
export function isUrgent(session) {
  return session.attention !== null && ATTENTION[session.attention].isUrgent
}

/**
 * @param {SessionView} session
 * @param {Filters} filters
 * @param {number} now
 * @returns {boolean}
 */
function inTimeWindow(session, filters, now) {
  if (filters.time === 'active') return ACTIVE_LIFECYCLES.includes(session.lifecycle)
  const preset = TIME_PRESETS.find(p => p.value === filters.time)
  if (!preset || preset.ms === null) return true
  return now - session.lastActivityAt <= preset.ms
}

/**
 * The projects the map packs first (2.1): those with a session inside the
 * time window or a pinned one. Only the time window and pins count, so
 * search, bucket and project filters never move anything.
 * @param {{ sessions: readonly SessionView[] }} snapshot
 * @param {Filters} filters
 * @param {number} now
 * @param {readonly string[]} [pinned]
 * @returns {Set<string>}
 */
export function packedProjects(snapshot, filters, now, pinned = []) {
  const isPinned = new Set(pinned)
  return new Set(snapshot.sessions.filter(s => isPinned.has(s.key) || inTimeWindow(s, filters, now)).map(s => s.projectId))
}

/**
 * @param {AgentView} agent
 * @param {Filters} filters
 * @param {number} now
 * @returns {boolean}
 */
function agentInTimeWindow(agent, filters, now) {
  if (ACTIVE_LIFECYCLES.includes(agent.lifecycle)) return true
  if (filters.time === 'active') return false
  const preset = TIME_PRESETS.find(p => p.value === filters.time)
  if (!preset || preset.ms === null) return true
  const at = agent.lastActivityAt ?? agent.finishedAt ?? agent.startedAt
  return at !== null && now - at <= preset.ms
}

/**
 * @param {SessionView} session
 * @param {ProjectView | undefined} project
 * @param {AgentView[]} agents
 * @param {string[]} terms
 * @returns {boolean}
 */
function matchesSearch(session, project, agents, terms) {
  if (terms.length === 0) return true
  const haystack = [
    session.title,
    session.summary,
    session.activity ?? '',
    session.cwd ?? '',
    session.branch ?? '',
    session.model ?? '',
    session.localId ?? '',
    session.cliSessionId ?? '',
    project?.name ?? '',
    project?.remote ?? '',
    ...agents.map(a => `${a.type} ${a.description}`),
  ]
    .join('\n')
    .toLowerCase()
  return terms.every(term => haystack.includes(term))
}

/**
 * @param {import('../types').SnapshotV2 & { graph?: Snapshot['graph'] }} snapshot
 * @param {Filters} filters
 * @param {Settings} settings
 * @param {readonly string[]} collapsed
 * @param {number} now
 * @param {VisibleOptions} [options]
 * @returns {VisibleView}
 */
export function visibleOf(snapshot, filters, settings, collapsed, now, options = {}) {
  const { pinned: pinnedKeys = [], expanded = [], showAll = [], hidden = {}, keepNeedsYouInProject = false } = options
  const isPinned = new Set(pinnedKeys)
  const all = isPinned.size === 0 ? snapshot.sessions : snapshot.sessions.map(s => (isPinned.has(s.key) ? { ...s, isPinned: true } : s))
  const graph = options.graph ?? snapshot.graph ?? { nodes: [], edges: [] }
  const projectById = new Map(snapshot.projects.map(p => [p.id, p]))
  /** @type {Map<string, AgentView[]>} */
  const agentsBySession = new Map()
  for (const agent of snapshot.agents) {
    const list = agentsBySession.get(agent.sessionKey) ?? []
    list.push(agent)
    agentsBySession.set(agent.sessionKey, list)
  }
  const terms = filters.search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const isCollapsed = new Set(collapsed)

  /** @type {SessionView[]} */
  const inWindow = []
  /** @type {SessionView[]} */
  const matching = []
  for (const s of all) {
    const isInWindow = inTimeWindow(s, filters, now)
    if (isInWindow) inWindow.push(s)
    if (isPinned.has(s.key)) {
      matching.push(s)
      continue
    }
    if (!isInWindow) continue
    if (!filters.showCompleted && s.lifecycle === 'completed') continue
    if (!filters.showStale && (s.lifecycle === 'stale' || s.lifecycle === 'disconnected')) continue
    if (filters.attentionOnly && !isUrgent(s)) continue
    if (filters.project !== '' && s.projectId !== filters.project && !(keepNeedsYouInProject && s.status?.bucket === 'needs-you')) continue
    if (filters.model !== '' && s.model !== filters.model) continue
    if (filters.lifecycle !== '' && s.lifecycle !== filters.lifecycle) continue
    if (filters.phase !== '' && s.phase !== filters.phase) continue
    if (!matchesSearch(s, projectById.get(s.projectId), agentsBySession.get(s.key) ?? [], terms)) continue
    matching.push(s)
  }
  matching.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  /** @type {SessionView[]} */
  const sessions = []
  /** @type {Set<string>} */
  const hiddenKeys = new Set()
  for (const s of matching) {
    if (isHiddenNow(s, hidden)) hiddenKeys.add(s.key)
    else sessions.push(s)
  }

  const sessionByKey = new Map(sessions.map(s => [s.key, s]))
  const visibleProjectIds = new Set(sessions.map(s => s.projectId))

  /** @type {AgentView[]} */
  const agents = []
  /** @type {Set<string>} */
  const shownAgentKeys = new Set()
  /** @type {Map<string, AgentView[]>} */
  const hiddenBySession = new Map()
  const rank = (/** @type {AgentView} */ a) =>
    a.lifecycle === 'running' ? 0 : a.lifecycle === 'waiting-user' || a.lifecycle === 'waiting-permission' ? 1 : a.lifecycle === 'failed' ? 2 : 3
  const cap = Math.max(0, settings.maxSubagents)
  const isExpanded = new Set(expanded)
  const isShowAll = new Set(showAll)
  /** @type {Map<string, number>} */
  const agentCount = new Map()
  for (const session of sessions) {
    const showsAll = isShowAll.has(session.key)
    const list = (agentsBySession.get(session.key) ?? [])
      .filter(a => showsAll || ((filters.showCompleted || a.lifecycle !== 'completed') && agentInTimeWindow(a, filters, now)))
      .sort((a, b) => rank(a) - rank(b) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    for (const agent of list) agents.push(agent)
    agentCount.set(session.key, list.length)
    if (showsAll || isExpanded.has(session.key)) {
      for (const agent of list) shownAgentKeys.add(agent.key)
      continue
    }
    for (const agent of list.slice(0, cap)) shownAgentKeys.add(agent.key)
    if (list.length > cap) hiddenBySession.set(session.key, list.slice(cap))
  }

  const nodeById = new Map(graph.nodes.map(n => [n.id, n]))
  const projectHasManyWorktrees = new Set(snapshot.projects.filter(p => p.worktreeIds.length > 1).map(p => p.id))
  const worktreeById = new Map(snapshot.worktrees.map(w => [w.id, w]))
  /** @type {Map<string, number>} */
  const sessionsPerProject = new Map()
  /** @type {Record<string, { sessions: number, running: number }>} */
  const projectCounts = Object.create(null)
  let runningSessions = 0
  for (const s of sessions) {
    sessionsPerProject.set(s.projectId, (sessionsPerProject.get(s.projectId) ?? 0) + 1)
    const entry = projectCounts[s.projectId] ?? { sessions: 0, running: 0 }
    entry.sessions += 1
    if (s.lifecycle === 'running') {
      entry.running += 1
      runningSessions += 1
    }
    projectCounts[s.projectId] = entry
  }

  /** @type {Record<string, Overflow>} */
  const overflow = {}
  /** @type {GraphNode[]} */
  const nodes = []
  /** @type {Map<string, GraphNode>} */
  const sessionNodeByKey = new Map()
  for (const node of graph.nodes) {
    if (node.kind === 'project') {
      if (!visibleProjectIds.has(node.ref)) continue
      if (isCollapsed.has(node.id)) overflow[node.id] = { count: sessionsPerProject.get(node.ref) ?? 0, reason: 'collapsed', noun: 'session' }
      nodes.push(node)
    } else if (node.kind === 'session') {
      const session = sessionByKey.get(node.ref)
      if (!session || isCollapsed.has(`p:${session.projectId}`)) continue
      const hidden = isCollapsed.has(node.id) ? (agentCount.get(session.key) ?? 0) : (hiddenBySession.get(session.key)?.length ?? 0)
      if (hidden > 0) overflow[node.id] = { count: hidden, reason: isCollapsed.has(node.id) ? 'collapsed' : 'cap', noun: 'subagent' }
      nodes.push(node)
      sessionNodeByKey.set(session.key, node)
    } else if (node.kind === 'agent') {
      if (!shownAgentKeys.has(node.ref)) continue
      const sessionNode = nodeById.get(sessionNodeIdOfAgent(node, nodeById))
      if (!sessionNode || isCollapsed.has(sessionNode.id)) continue
      const session = sessionByKey.get(sessionNode.ref)
      if (!session || isCollapsed.has(`p:${session.projectId}`)) continue
      nodes.push(node)
    } else if (node.kind === 'worktree') {
      const parent = node.parent ? nodeById.get(node.parent) : undefined
      if (!parent || !visibleProjectIds.has(parent.ref) || isCollapsed.has(parent.id)) continue
      if (!projectHasManyWorktrees.has(parent.ref)) continue
      const linked = worktreeById.get(node.ref)
      if (!linked || linked.isMain || !linked.sessionKeys.some(k => sessionByKey.has(k))) continue
      nodes.push(node)
    } else if (node.kind === 'pr') {
      if (!settings.showPRs) continue
      const parent = node.parent ? nodeById.get(node.parent) : undefined
      const session = parent ? sessionByKey.get(parent.ref) : undefined
      if (!parent || !session || isCollapsed.has(parent.id) || isCollapsed.has(`p:${session.projectId}`)) continue
      nodes.push(node)
    }
  }

  /** @type {Set<string>} */
  const shown = new Set()
  for (const n of nodes) shown.add(n.id)
  /** @type {GraphEdge[]} */
  const edges = []
  for (const e of graph.edges) if (shown.has(e.from) && shown.has(e.to)) edges.push(e)

  const attention = all
    .filter(s => isUrgent(s) && (inTimeWindow(s, filters, now) || s.lifecycle === 'waiting-user' || s.lifecycle === 'waiting-permission'))
    .sort((a, b) => {
      const ra = a.attention ? ATTENTION[a.attention].rank : 9
      const rb = b.attention ? ATTENTION[b.attention].rank : 9
      return ra - rb || b.lastActivityAt - a.lastActivityAt
    })

  let agentsRunning = 0
  for (const a of agents) {
    if (a.lifecycle !== 'running') continue
    agentsRunning += 1
    const session = sessionByKey.get(a.sessionKey)
    const entry = session ? projectCounts[session.projectId] : undefined
    if (entry) entry.running += 1
  }
  const projectsInWindow = new Set(inWindow.map(s => s.projectId))
  const projectOptions = snapshot.projects
    .filter(p => projectsInWindow.has(p.id))
    .map(p => ({ value: p.id, label: p.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const models = [...new Set(inWindow.map(s => s.model).filter(m => typeof m === 'string'))]
  const modelOptions = /** @type {string[]} */ (models).sort().map(m => ({ value: m, label: m }))

  /** @type {SessionView[]} */
  const pinned = []
  if (isPinned.size > 0) {
    for (const s of all) {
      if (!isPinned.has(s.key)) continue
      if (isHiddenNow(s, hidden)) hiddenKeys.add(s.key)
      else pinned.push(s)
    }
    pinned.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }
  const peers = checkoutPeers(all)

  return {
    sessions,
    nodes,
    edges,
    attention,
    pinned,
    peers,
    overflow,
    projectCounts,
    counts: {
      sessions: sessions.length,
      running: runningSessions,
      attention: attention.length,
      agentsRunning,
    },
    projectOptions,
    modelOptions,
    hiddenCount: hiddenKeys.size,
  }
}

/**
 * Whether Orbit keeps `session` out of view: it was hidden, has had no
 * activity since, and does not need you. New activity or a need brings it
 * back by itself; nothing in Claude changes.
 * @param {SessionView} session
 * @param {Readonly<Record<string, number>> | null | undefined} hidden session key → its last activity when hidden
 * @returns {boolean}
 */
export function isHiddenNow(session, hidden) {
  const at = hidden && Object.hasOwn(hidden, session.key) ? hidden[session.key] : undefined
  return typeof at === 'number' && session.lastActivityAt <= at && !isUrgent(session)
}

/**
 * The `hidden` preference cleaned for storage: finite, non-negative times
 * under keys of at most 600 characters, the `max` most recently active kept.
 * @param {unknown} raw
 * @param {number} max
 * @returns {Record<string, number>}
 */
export function cleanHidden(raw, max) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const entries = Object.entries(raw).filter(
    /** @returns {entry is [string, number]} */ entry => entry[0].length <= 600 && typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0,
  )
  entries.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, Math.max(0, max)))
}

/**
 * @param {string} field
 * @param {string} term
 * @returns {number | null}
 */
function matchScore(field, term) {
  let at = field.indexOf(term)
  const isInside = at >= 0
  while (at >= 0) {
    if (at === 0) return 0
    if (!/[\p{L}\p{N}]/u.test(field.charAt(at - 1))) return 1
    at = field.indexOf(term, at + 1)
  }
  if (isInside) return 2
  let i = 0
  for (const ch of field) {
    if (ch === term[i]) i += 1
    if (i === term.length) return 3
  }
  return null
}

/**
 * The quick switcher's list: sessions where every word of `query` matches the
 * title, project or branch. Whole-text matches come before letters-in-order
 * ones; within each, Needs you first (in `attention` order), then the closest
 * matches (title before project and branch), then the most recent.
 * @param {readonly SessionView[]} sessions
 * @param {string} query
 * @param {(session: SessionView) => string} projectName
 * @param {readonly SessionView[]} attention the Needs you list, most urgent first (`VisibleView.attention`)
 * @returns {SessionView[]}
 */
export function rankSessions(sessions, query, projectName, attention) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  /** @type {{ session: SessionView, score: number, isLoose: boolean }[]} */
  const matched = []
  for (const session of sessions) {
    const fields = [session.title, projectName(session), session.branch ?? ''].map(f => f.toLowerCase())
    let score = 0
    let isLoose = false
    for (const term of terms) {
      let best = Infinity
      fields.forEach((field, i) => {
        const m = matchScore(field, term)
        if (m !== null) best = Math.min(best, m + (i === 0 ? 0 : 0.5))
      })
      score += best
      if (best >= 3) isLoose = true
      if (score === Infinity) break
    }
    if (score !== Infinity) matched.push({ session, score, isLoose })
  }
  const needsYou = new Map(attention.map((s, i) => [s.key, i]))
  const urgency = (/** @type {SessionView} */ s) => needsYou.get(s.key) ?? attention.length
  return matched
    .sort(
      (a, b) =>
        Number(a.isLoose) - Number(b.isLoose) ||
        urgency(a.session) - urgency(b.session) ||
        a.score - b.score ||
        b.session.lastActivityAt - a.session.lastActivityAt,
    )
    .map(m => m.session)
}

/**
 * Active sessions (running or waiting on you) that share a checkout with
 * another active session: they may be editing the same files. Sharing a
 * repository is not enough; it has to be the same working folder.
 * @param {readonly SessionView[]} sessions
 * @returns {Record<string, SessionView[]>}
 */
export function checkoutPeers(sessions) {
  /** @type {Map<string, SessionView[]>} */
  const byCheckout = new Map()
  for (const s of sessions) {
    if (!s.worktreeId || !ACTIVE_LIFECYCLES.includes(s.lifecycle)) continue
    const list = byCheckout.get(s.worktreeId) ?? []
    list.push(s)
    byCheckout.set(s.worktreeId, list)
  }
  /** @type {Record<string, SessionView[]>} */
  const out = {}
  for (const list of byCheckout.values()) {
    if (list.length < 2) continue
    for (const s of list) out[s.key] = list.filter(other => other.key !== s.key)
  }
  return out
}

/**
 * @param {GraphNode} node
 * @param {Map<string, GraphNode>} nodeById
 * @returns {string}
 */
function sessionNodeIdOfAgent(node, nodeById) {
  let current = node
  for (let depth = 0; depth < 8 && current.parent; depth += 1) {
    const parent = nodeById.get(current.parent)
    if (!parent) return ''
    if (parent.kind === 'session') return parent.id
    current = parent
  }
  return ''
}

/**
 * The node `rootId` and everything under it (it moves, collapses and frames as one).
 * @param {string} rootId
 * @param {readonly GraphNode[]} nodes
 * @returns {Set<string>}
 */
export function descendantsOf(rootId, nodes) {
  /** @type {Map<string, string[]>} */
  const children = new Map()
  for (const n of nodes) {
    if (!n.parent) continue
    const list = children.get(n.parent) ?? []
    list.push(n.id)
    children.set(n.parent, list)
  }
  const out = new Set([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    const id = /** @type {string} */ (queue.pop())
    for (const child of children.get(id) ?? []) {
      if (out.has(child)) continue
      out.add(child)
      queue.push(child)
    }
  }
  return out
}

/**
 * `list` with `item` added at the front, or taken out if it was there.
 * @param {readonly string[]} list
 * @param {string} item
 * @returns {string[]}
 */
export function toggled(list, item) {
  return list.includes(item) ? list.filter(x => x !== item) : [item, ...list]
}

const NEEDS_YOU_ATTENTION = new Set(['question', 'permission', 'needs-you', 'blocked'])
const STATUS_BUCKETS = new Set(['needs-you', 'working', 'review', 'idle', 'failed'])

/**
 * A session's or agent's `status` as written, or, when it is missing or
 * malformed, the contract's rules over lifecycle and attention (no desktop
 * facts or approvals: those only the server has). An unknown bucket reads
 * as idle.
 * @param {{ status?: unknown, lifecycle: string, attention?: string | null, attentionText?: string | null, stateSince?: number | null }} item
 * @returns {import('../types').Status}
 */
export function statusOrFallback(item) {
  const raw = /** @type {Partial<import('../types').Status> | null | undefined} */ (item.status)
  if (raw && typeof raw === 'object' && typeof raw.bucket === 'string' && typeof raw.reason === 'string') {
    const bucket = STATUS_BUCKETS.has(raw.bucket) ? raw.bucket : 'idle'
    return {
      bucket,
      reason: raw.reason.slice(0, 120),
      since: typeof raw.since === 'number' && Number.isFinite(raw.since) ? raw.since : null,
      isObserved: raw.isObserved === true,
      isDone: raw.isDone === true,
      snoozedUntil: typeof raw.snoozedUntil === 'number' && Number.isFinite(raw.snoozedUntil) ? raw.snoozedUntil : null,
    }
  }
  const since = typeof item.stateSince === 'number' ? item.stateSince : null
  if (item.attention && NEEDS_YOU_ATTENTION.has(item.attention)) return { bucket: 'needs-you', reason: item.attentionText || 'Needs you', since, isObserved: false }
  if (item.lifecycle === 'failed') return { bucket: 'failed', reason: 'Failed', since, isObserved: false }
  if (item.lifecycle === 'running' || item.lifecycle === 'stale') return { bucket: 'working', reason: 'Working', since, isObserved: false }
  return { bucket: 'idle', reason: 'Idle', since, isObserved: false }
}

/**
 * A snapshot with the fields newer versions added filled in, so one written
 * by an older server (sessions do not hot-reload) reads as "unknown", and
 * every session and agent has a `status`.
 * @template {import('../types').SnapshotV2 | Snapshot} T
 * @param {T} snapshot
 * @returns {T}
 */
export function normalizeSnapshot(snapshot) {
  const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    ...snapshot,
    usage: snapshot.usage && Array.isArray(snapshot.usage.rateLimits) ? snapshot.usage : null,
    sessions: snapshot.sessions.map(s => {
      const lifecycle = knownLifecycle(s.lifecycle)
      const attention = s.attention !== null && Object.hasOwn(ATTENTION, s.attention) ? s.attention : null
      const stateSince = num(s.stateSince)
      return { ...s, lifecycle, attention, stateSince, finishedAt: num(s.finishedAt), cost: num(s.cost), stuck: stuckOrNull(s.stuck), status: statusOrFallback({ ...s, lifecycle, attention, stateSince }) }
    }),
    agents: Array.isArray(snapshot.agents)
      ? snapshot.agents.map(a => {
          const lifecycle = knownLifecycle(a.lifecycle)
          return { ...a, lifecycle, status: statusOrFallback({ ...a, lifecycle, attention: null, stateSince: a.lastActivityAt }) }
        })
      : [],
  }
}

/**
 * @param {unknown} value
 * @returns {import('../types').Lifecycle}
 */
function knownLifecycle(value) {
  return typeof value === 'string' && Object.hasOwn(LIFECYCLE, value) ? /** @type {import('../types').Lifecycle} */ (value) : 'unknown'
}

/**
 * @param {unknown} raw
 * @returns {import('../types').StuckView | null}
 */
function stuckOrNull(raw) {
  const s = /** @type {Partial<import('../types').StuckView> | null | undefined} */ (raw)
  if (!s || typeof s !== 'object' || typeof s.text !== 'string' || typeof s.since !== 'number') return null
  if (s.kind !== 'repeat' && s.kind !== 'errors') return null
  return { kind: s.kind, text: s.text.slice(0, 160), since: s.since }
}

const PR_NEED_WINDOW_MS = 24 * 60 * 60_000

/**
 * "PR problems need you" (after C9): each PR with failing checks or changes
 * requested belongs to the newest session linking it, by session key, with
 * its reason (`PR checks failing: owner/repo#7`) and when the problem was
 * first seen. A session idle for over a day, or hidden, gets none, and the
 * PR does not pass to an older session.
 * @param {readonly SessionView[]} sessions
 * @param {Readonly<Record<string, import('../types').PrStatus>> | null} statuses by PR URL
 * @param {number} now
 * @param {Readonly<Record<string, number>>} [hidden] sessions hidden until active
 * @returns {Map<string, { reason: string, since: number }>}
 */
export function prProblems(sessions, statuses, now, hidden = {}) {
  /** @type {Map<string, { reason: string, since: number }>} */
  const out = new Map()
  if (!statuses) return out
  /** @type {Set<string>} */
  const taken = new Set()
  for (const s of [...sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt)) {
    for (const pr of s.prs) {
      if (taken.has(pr.url)) continue
      const status = Object.hasOwn(statuses, pr.url) ? statuses[pr.url] : undefined
      const problem = status ? prProblem(status) : null
      if (!status || !problem) continue
      taken.add(pr.url)
      if (out.has(s.key) || now - s.lastActivityAt > PR_NEED_WINDOW_MS || isHiddenNow(s, hidden)) continue
      out.set(s.key, { reason: `PR ${problem.toLowerCase()}: ${pr.repo}#${pr.number}`, since: status.since ?? status.checkedAt })
    }
  }
  return out
}

/**
 * What needs you about a PR, in a few words, or null: only open (or draft)
 * PRs with failing checks or changes requested.
 * @param {import('../types').PrStatus} status
 * @returns {string | null}
 */
export function prProblem(status) {
  if (status.state !== 'open' && status.state !== 'draft') return null
  if (status.checks === 'failing') return 'Checks failing'
  if (status.review === 'changes') return 'Changes requested'
  return null
}
