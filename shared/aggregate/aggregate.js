// @ts-check

import { MOD_VERSION } from '../constants.js'
import { lastEntryAt, TRANSCRIPT_MAX_BYTES } from '../conversation.js'
import { attributeProject, isCheckoutOf } from './attribution.js'
import { basename, errorText, joinWith, normalizePath } from './path-utils.js'
import { createDesktopCache, isWrittenPastEdge, scanDesktop, withTranscriptActivity } from './desktop.js'
import { branchOf, createBranchCache, pruneBranchCache } from './git.js'
import { cleanRecord, describeTool } from './redact.js'
import { createSubagentCache, forgetSubagents, projectDirFor, readSubagents } from './subagents.js'
import { agentLifecycle, evidence, lifecycleOf, messageBlockOf, phaseFromDesktop, publisherActivityAt, phaseFromTools, stuckOf, withRunningAgents } from './infer.js'

/** @typedef {import('../../types').AgentView} AgentView */
/** @typedef {import('../../types').Environment} Environment */
/** @typedef {import('../../types').ProjectView} ProjectView */
/** @typedef {import('../../types').PublishedSession} PublishedSession */
/** @typedef {import('../../types').SessionView} SessionView */
/** @typedef {import('../../types').Settings} Settings */
/**
 * One aggregation, before the server adds its identity and `status` (`toV2`).
 * @typedef {Omit<import('../../types').SnapshotV2, 'schema' | 'generator' | 'serverVersion' | 'seq' | 'bootId'> & { schema: 1, generator: string, modVersion: string }} Aggregated
 */
/** @typedef {import('../../types').SourceHealth} SourceHealth */
/** @typedef {import('../../types').TimelineEntry} TimelineEntry */
/** @typedef {import('../../types').WorktreeView} WorktreeView */
/** @typedef {import('../../types').Offset} Offset */
/** @typedef {import('../../types').RateLimitView} RateLimitView */
/** @typedef {import('../../types').UsageView} UsageView */
/** @typedef {import('../../src/paths').Paths} Paths */
/** @typedef {import('./path-utils.js').Host} Host */
/** @typedef {import('./desktop.js').DesktopCache} DesktopCache */
/** @typedef {import('./desktop.js').DesktopSession} DesktopSession */
/** @typedef {import('./git.js').BranchCache} BranchCache */
/** @typedef {import('./subagents.js').SubagentCache} SubagentCache */
/** @typedef {import('./subagents.js').SubagentMeta} SubagentMeta */

const PUBLISHER_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const META_WINDOW_MS = 24 * 60 * 60_000
const MAX_AGENTS_PER_SESSION = 40
const ACTIVITY_WINDOW_MS = 3 * 60_000
const MAX_TIMELINE = 12
const USAGE_MAX_AGE_MS = 6 * 60 * 60_000
const LIVE_WINDOW_MS = 24 * 60 * 60_000

/**
 * @param {unknown} raw
 * @returns {RateLimitView[]}
 */
function rateLimitsOf(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      /**
       * @param {any} l
       * @returns {l is { kind: string, percentUsed: number, resetsAt?: unknown }}
       */
      l => typeof l?.kind === 'string' && typeof l?.percentUsed === 'number' && Number.isFinite(l.percentUsed),
    )
    .slice(0, 4)
    .map(l => ({ kind: l.kind.slice(0, 40), percentUsed: Math.min(1000, Math.max(0, l.percentUsed)), resetsAt: typeof l.resetsAt === 'string' ? l.resetsAt.slice(0, 40) : null }))
}

/**
 * @param {Iterable<PublishedSession>} publishers
 * @param {number} now
 * @returns {UsageView | null}
 */
function usageOf(publishers, now) {
  /** @type {{ at: number, limits: RateLimitView[] } | null} */
  let best = null
  for (const p of publishers) {
    const limits = rateLimitsOf(p.rateLimits)
    if (limits.length === 0 || typeof p.usageAt !== 'number' || now - p.usageAt > USAGE_MAX_AGE_MS) continue
    if (!best || best.at < p.usageAt) best = { at: p.usageAt, limits }
  }
  return best ? { rateLimits: best.limits, evidence: evidence('mod-events', 'observed', best.at, 'session.measure') } : null
}

/**
 * @typedef {object} PublisherCache
 * @property {Map<string, { mtimeMs: number, record: PublishedSession | null, checkedAt: number }>} files
 * @property {number} count
 * @property {number} failed
 */

const FAILED_RETRY_MS = 5_000

/** @returns {PublisherCache} */
function createPublisherCache() {
  return { files: new Map(), count: 0, failed: 0 }
}

/**
 * Parses the newest `limit` publisher records in `dir` modified after
 * `minMtime` and within the last week, re-redacted on read (`cleanRecord`);
 * an unchanged file is not read again, unless it failed to parse (a read
 * during its writer's write), which is retried after FAILED_RETRY_MS.
 * @param {Host} $
 * @param {PublisherCache} cache
 * @param {string} dir
 * @param {string} sep
 * @param {number} now
 * @param {{ limit: number }} options
 * @returns {Promise<PublishedSession[]>}
 */
async function readPublishers($, cache, dir, sep, now, options) {
  /** @type {PublishedSession[]} */
  const out = []
  cache.count = 0
  cache.failed = 0
  /** @type {Awaited<ReturnType<Host['fs']['list']>>} */
  let entries = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return out
  }
  const fresh = entries
    .filter(e => e.kind === 'file' && e.name.endsWith('.json') && now - e.mtimeMs <= PUBLISHER_MAX_AGE_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, options.limit)
  /** @type {Set<string>} */
  const seen = new Set()
  for (const entry of fresh) {
    cache.count += 1
    const path = joinWith(sep, dir, entry.name)
    seen.add(path)
    let cached = cache.files.get(path)
    if (!cached || cached.mtimeMs !== entry.mtimeMs || (cached.record === null && now - cached.checkedAt >= FAILED_RETRY_MS)) {
      /** @type {PublishedSession | null} */
      let record = null
      try {
        const parsed = /** @type {PublishedSession} */ (JSON.parse(await $.fs.read(path)))
        record = parsed && parsed.schema === 1 && typeof parsed.cliSessionId === 'string' ? cleanRecord(parsed) : null
      } catch {
        record = null
      }
      cached = { mtimeMs: entry.mtimeMs, record, checkedAt: now }
      cache.files.set(path, cached)
    }
    if (cached.record) out.push(cached.record)
    else cache.failed += 1
  }
  for (const key of [...cache.files.keys()]) if (!seen.has(key)) cache.files.delete(key)
  return out
}

const TRANSCRIPT_CHECK_WINDOW_MS = 24 * 60 * 60_000

/** @typedef {{ path: string, mtimeMs: number, size: number }} TranscriptFile */

const LISTING_TTL_MS = 45_000
const LISTING_FORGET_MS = 10 * 60_000

/** @typedef {Map<string, { at: number, files: Map<string, { mtimeMs: number, size: number }> }>} ListingCache */

/** @returns {ListingCache} */
export function createListingCache() {
  return new Map()
}

/**
 * A project folder's transcript files, listed once and kept for 45 s; past
 * that, a run lists again only as many stale folders as its budget allows
 * (one), so the busiest folders are not re-listed every run (E-108).
 * @param {Pick<Host, 'fs'> | { fs: Pick<Host['fs'], 'list'> }} $
 * @param {ListingCache} cache
 * @param {string} sep
 * @param {string} projectsDir
 * @param {string} dir
 * @param {number} now
 * @param {{ left: number }} budget
 * @returns {Promise<Map<string, { mtimeMs: number, size: number }>>}
 */
export async function listingOf($, cache, sep, projectsDir, dir, now, budget) {
  const cached = cache.get(dir)
  if (cached && (now - cached.at < LISTING_TTL_MS || budget.left <= 0)) return cached.files
  if (cached) budget.left -= 1
  /** @type {Map<string, { mtimeMs: number, size: number }>} */
  const files = new Map()
  try {
    for (const entry of await $.fs.list(joinWith(sep, projectsDir, dir))) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) files.set(entry.name, { mtimeMs: entry.mtimeMs, size: entry.size })
    }
  } catch {}
  cache.set(dir, { at: now, files })
  return files
}

/**
 * @param {Host} $
 * @param {Readers} readers
 * @param {Paths} paths
 * @param {DesktopSession} d
 * @param {number} now
 * @param {{ left: number }} budget
 * @returns {Promise<TranscriptFile | null>}
 */
async function transcriptFileOf($, readers, paths, d, now, budget) {
  if (!d.cwd) return null
  const dir = await projectDirFor($, readers.subagents, paths.projectsDir, d.cwd, now)
  if (!dir) return null
  const files = await listingOf($, readers.listings, paths.sep, paths.projectsDir, dir, now, budget)
  /** @type {TranscriptFile | null} */
  let latest = null
  for (const id of d.cliSessionIds) {
    const name = `${id}.jsonl`
    const file = files.get(name)
    if (file && (latest === null || file.mtimeMs > latest.mtimeMs)) latest = { path: joinWith(paths.sep, paths.projectsDir, dir, name), ...file }
  }
  return latest
}

/** @typedef {Map<string, { mtimeMs: number, size: number, lastEntryAt: number | null, isRead: boolean }>} TranscriptCache */

/**
 * The time of a transcript's last conversation entry, read only when its
 * write time says a turn may be open and cached until the file changes. The
 * engine reads whole files only (up to 4 MiB), so a larger one is not read.
 * @param {Host} $
 * @param {TranscriptCache} cache
 * @param {TranscriptFile} file
 * @returns {Promise<{ lastEntryAt: number | null, isRead: boolean }>}
 */
async function lastEntryOf($, cache, file) {
  const cached = cache.get(file.path)
  if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) return cached
  let entry = { mtimeMs: file.mtimeMs, size: file.size, lastEntryAt: /** @type {number | null} */ (null), isRead: false }
  if (file.size <= TRANSCRIPT_MAX_BYTES) {
    try {
      entry = { ...entry, lastEntryAt: lastEntryAt(await $.fs.read(file.path)), isRead: true }
    } catch {}
  }
  cache.set(file.path, entry)
  return entry
}

/**
 * @typedef {object} Readers
 * @property {DesktopCache} desktop
 * @property {PublisherCache} publishers
 * @property {SubagentCache} subagents
 * @property {BranchCache} branches
 * @property {TranscriptCache} transcripts
 * @property {ListingCache} listings
 */

/** @returns {Readers} */
export function createReaders() {
  return {
    desktop: createDesktopCache(),
    publishers: createPublisherCache(),
    subagents: createSubagentCache(),
    branches: createBranchCache(),
    listings: createListingCache(),
    transcripts: new Map(),
  }
}

/** @typedef {{ projectId: string, root: string, name: string, remote: string | null, worktree: string | null }} Identity */

/**
 * @param {string} path
 * @returns {number}
 */
function worktreeSegment(path) {
  return path.split(/[\\/]+/).findIndex((part, i, parts) => part === '.claude' && parts[i + 1] === 'worktrees')
}

/**
 * @param {string} cwd
 * @returns {string}
 */
function projectRootOfCwd(cwd) {
  const parts = cwd.split(/[\\/]+/)
  const at = worktreeSegment(cwd)
  return at > 0 ? parts.slice(0, at).join('\\') : cwd
}

/**
 * @param {string} cwd
 * @returns {string | null}
 */
function worktreeOfCwd(cwd) {
  const parts = cwd.split(/[\\/]+/)
  const at = worktreeSegment(cwd)
  return at > 0 && parts[at + 2] ? parts.slice(0, at + 3).join('\\') : null
}

/**
 * @param {string} path
 * @param {string} folder
 * @returns {boolean}
 */
function isInside(path, folder) {
  const p = normalizePath(path)
  const f = normalizePath(folder)
  return p === f || p.startsWith(`${f}\\`)
}

/**
 * Which project (main checkout) and which checkout a session belongs to:
 * the desktop's git anchors when there are any, else the session's own repo
 * root with `.claude\worktrees\<name>` folded into its repository.
 * @param {DesktopSession | null} desktop
 * @param {PublishedSession | null} pub
 * @returns {Identity}
 */
export function identityOf(desktop, pub) {
  const cwd = desktop?.cwd ?? pub?.cwd ?? ''
  /** @type {string} */
  let root
  /** @type {string | null} */
  let worktree = null
  if (desktop?.commonDir) {
    root = desktop.commonDir.replace(/[\\/]\.git[\\/]?$/i, '')
    worktree = desktop.gitRoot ?? root
  } else if (pub?.repoRoot) {
    root = projectRootOfCwd(pub.repoRoot)
    worktree = worktreeOfCwd(cwd) ?? (isInside(cwd, root) ? root : cwd)
  } else {
    root = projectRootOfCwd(cwd) || 'Unknown folder'
  }
  const repoName = pub?.repoName?.split('/').at(-1)
  return {
    projectId: normalizePath(root),
    root,
    name: repoName ?? basename(root),
    remote: pub?.repoRoot && normalizePath(projectRootOfCwd(pub.repoRoot)) === normalizePath(root) ? pub.repoRemote : null,
    worktree,
  }
}

/**
 * @param {DesktopSession | null} desktop
 * @param {PublishedSession | null} pub
 * @returns {Environment}
 */
function environmentOf(desktop, pub) {
  if (desktop) return 'desktop'
  const entry = pub?.entrypoint ?? ''
  if (entry === 'cli') return 'terminal'
  if (/vscode|jetbrains|ide/i.test(entry)) return 'ide'
  return 'unknown'
}

/**
 * @param {DesktopSession | null} desktop
 * @param {PublishedSession | null} pub
 * @returns {TimelineEntry[]}
 */
function timelineOf(desktop, pub) {
  /** @type {TimelineEntry[]} */
  const entries = [...(pub?.timeline ?? [])]
  if (!pub && desktop) {
    if (desktop.createdAt) entries.push({ at: desktop.createdAt, kind: 'note', text: 'Session created' })
    if (desktop.lastTurnEdgeAt) entries.push({ at: desktop.lastTurnEdgeAt, kind: 'turn', text: 'Last turn ended' })
    if (desktop.summary.detail) entries.push({ at: desktop.lastActivityAt, kind: 'state', text: desktop.summary.detail })
  }
  return entries.sort((a, b) => b.at - a.at).slice(0, MAX_TIMELINE)
}

/**
 * @typedef {object} AggregateContext
 * @property {Paths} paths
 * @property {Readers} readers
 * @property {Settings} settings
 * @property {string} me
 * @property {number} now
 * @property {readonly string[]} pinned Session keys always kept, past the `maxSessions` cap.
 * @property {ReadonlyMap<string, ReadonlyMap<string, number>>} [editRoots] per session key, how many edited files land in each repository (G-17, from the server)
 * @property {Readonly<Record<string, string>>} [projectOverrides] session key → project id, from prefs (G-17)
 * @property {Readonly<Record<string, string>>} [titles] session key → the name the person gave it in Orbit, from prefs
 * @property {Readonly<Record<string, string>>} [tints] session key → the icon colour the person chose, from prefs
 * @property {Readonly<Record<string, string>>} [projectTints] project id → the default icon colour of its sessions, from prefs
 * @property {string} [home] the profile folder, for weak places
 * @property {(checkout: string) => string} [repositoryOf] the repository a checkout belongs to, so worktrees of one repository group together (2.1, from the server)
 */

/** @typedef {{ desktop: DesktopSession | null, pub: PublishedSession | null }} Pair */

/**
 * @param {Host} $
 * @param {AggregateContext} ctx
 * @returns {Promise<Aggregated>}
 */
export async function aggregate($, ctx) {
  const started = Date.now()
  const { paths, readers, settings, now, me } = ctx
  const staleMs = settings.staleMinutes * 60_000
  /** @type {string[]} */
  const errors = []

  const pinned = new Set(ctx.pinned)
  const desktop = await scanDesktop($, readers.desktop, paths.desktopRoot, paths.sep, settings.maxSessions, pinned)
  if (desktop.error) errors.push(`desktop: ${desktop.error}`)
  const limit = settings.maxSessions * 2
  const publishers = await readPublishers($, readers.publishers, paths.sessionsDir, paths.sep, now, { limit })

  /** @type {Map<string, PublishedSession>} */
  const pubById = new Map()
  for (const p of publishers) {
    const existing = pubById.get(p.cliSessionId)
    if (!existing || existing.updatedAt < p.updatedAt) pubById.set(p.cliSessionId, p)
  }

  const pubOf = (/** @type {DesktopSession} */ d) =>
    d.cliSessionIds
      .map(id => pubById.get(id))
      .filter(p => p !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null

  const listingBudget = { left: 1 }
  const branchBudget = { left: 3 }
  for (const [dir, entry] of readers.listings) if (now - entry.at > LISTING_FORGET_MS) readers.listings.delete(dir)
  /** @type {Set<string>} */
  const readTranscripts = new Set()
  for (let i = 0; i < desktop.sessions.length; i += 1) {
    const d = desktop.sessions[i]
    if (!d || d.isMidTurn || now - d.lastTurnEdgeAt > TRANSCRIPT_CHECK_WINDOW_MS) continue
    const hasLivePub = d.cliSessionIds.some(id => pubById.get(id)?.endedAt === null)
    if (hasLivePub) continue
    const file = await transcriptFileOf($, readers, paths, d, now, listingBudget)
    if (!file || !isWrittenPastEdge(d, file.mtimeMs, now, staleMs)) continue
    readTranscripts.add(file.path)
    const entry = await lastEntryOf($, readers.transcripts, file)
    desktop.sessions[i] = withTranscriptActivity(d, { writtenAt: file.mtimeMs, ...entry }, now, staleMs, pubOf(d)?.endedAt ?? null)
  }
  for (const path of [...readers.transcripts.keys()]) if (!readTranscripts.has(path)) readers.transcripts.delete(path)

  /** @type {Pair[]} */
  const pairs = []
  /** @type {Set<string>} */
  const usedPubs = new Set()
  for (const d of desktop.sessions) {
    const pub = pubOf(d)
    if (pub) usedPubs.add(pub.cliSessionId)
    pairs.push({ desktop: d, pub })
  }
  for (const pub of pubById.values()) {
    if (usedPubs.has(pub.cliSessionId) || pub.entrypoint === 'claude-desktop') continue
    pairs.push({ desktop: null, pub })
  }

  const lastActivity = (/** @type {Pair} */ p) => Math.max(p.desktop?.lastActivityAt ?? 0, p.pub ? publisherActivityAt(p.pub, p.desktop !== null) : 0)
  pairs.sort((a, b) => lastActivity(b) - lastActivity(a))
  const keyOf = (/** @type {Pair} */ p) => (p.desktop ? p.desktop.localId : `cli:${p.pub?.cliSessionId ?? 'unknown'}`)
  const kept = pairs.filter((p, i) => i < settings.maxSessions || pinned.has(keyOf(p)))

  /** @type {SessionView[]} */
  const sessions = []
  /** @type {AgentView[]} */
  const agents = []
  /** @type {Map<string, ProjectView>} */
  const projects = new Map()
  /** @type {Map<string, WorktreeView>} */
  const worktrees = new Map()
  /** @type {Set<string>} */
  const metaKeys = new Set()

  for (const { desktop: d, pub } of kept) {
    const key = keyOf({ desktop: d, pub })
    let id = identityOf(d, pub)
    const decided = attributeProject({ startRoot: id.root, editRoots: ctx.editRoots?.get(key) ?? new Map(), override: ctx.projectOverrides?.[key] ?? null, home: ctx.home ?? '', repositoryOf: ctx.repositoryOf })
    if (decided.source !== 'folder') {
      const root = projectRootOfCwd(decided.root)
      id = { projectId: normalizePath(root), root, name: basename(root), remote: null, worktree: decided.worktree }
    }
    if (id.worktree && !isCheckoutOf({ checkout: id.worktree, root: id.root, home: ctx.home ?? '', repositoryOf: ctx.repositoryOf })) id = { ...id, worktree: null }
    const cliSessionId = pub?.cliSessionId ?? d?.cliSessionIds[0] ?? null
    const lastActivityAt = lastActivity({ desktop: d, pub })
    const life = lifecycleOf({ desktop: d, publisher: pub, now, staleMs })
    const livePub = pub && pub.endedAt === null ? pub : null
    const messageBlock = messageBlockOf(cliSessionId, pub, d, now)
    const isPlanMode = d?.permissionMode === 'plan'
    let phase = livePub
      ? phaseFromTools(livePub.tools, now, { isPlanMode, waiting: livePub.waiting, agentId: null })
      : { phase: /** @type {const} */ ('unknown'), evidence: evidence('none', 'unknown', null) }
    if (phase.phase === 'unknown' && d) phase = phaseFromDesktop(d)
    if (life.attention === 'blocked' && (phase.phase === 'unknown' || phase.phase === 'general')) {
      phase = { phase: 'blocked', evidence: life.evidence }
    }

    /** @type {string | null} */
    let branch = null
    const gitRoot = id.worktree ?? (d?.gitRoot ?? null)
    if (gitRoot) branch = await branchOf($, readers.branches, paths.sep, gitRoot, now, branchBudget)
    branch ??= d?.writtenBranches.at(-1) ?? d?.prs[0]?.branch ?? null

    /** @type {string | null} */
    let activity = null
    if (life.lifecycle === 'running' && livePub) {
      const lastMain = [...livePub.tools].reverse().find(t => t.agentId === null)
      activity = lastMain && (lastMain.pending === true || now - lastMain.at < ACTIVITY_WINDOW_MS) ? describeTool(lastMain.category, lastMain.target) : 'Working (no recent tool call)'
    } else if (life.attentionText && (life.lifecycle === 'waiting-permission' || life.lifecycle === 'waiting-user')) {
      activity = life.attentionText
    }

    const ownTitle = d?.title ?? `${basename(pub?.cwd ?? 'session')} (${environmentOf(d, pub)})`
    const renamed = ctx.titles?.[key] ?? null
    const title = renamed ?? ownTitle
    const tint = ctx.tints?.[key] ?? ctx.projectTints?.[id.projectId] ?? null
    const summary = d?.summary.detail || (livePub ? pub?.timeline.at(-1)?.text ?? '' : '') || title

    const project = projects.get(id.projectId) ?? {
      id: id.projectId,
      name: id.name,
      root: id.root,
      remote: id.remote,
      sessionKeys: [],
      worktreeIds: [],
      lastActivityAt: 0,
      activeAgents: 0,
    }
    project.sessionKeys.push(key)
    project.lastActivityAt = Math.max(project.lastActivityAt, lastActivityAt)
    project.remote ??= id.remote
    if (life.lifecycle === 'running') project.activeAgents += 1
    projects.set(id.projectId, project)

    /** @type {string | null} */
    let worktreeId = null
    if (id.worktree) {
      worktreeId = normalizePath(id.worktree)
      const worktree = worktrees.get(worktreeId) ?? {
        id: worktreeId,
        projectId: id.projectId,
        path: id.worktree,
        isMain: normalizePath(id.worktree) === normalizePath(id.root),
        branch,
        sessionKeys: [],
      }
      worktree.sessionKeys.push(key)
      worktrees.set(worktreeId, worktree)
      if (!project.worktreeIds.includes(worktreeId)) project.worktreeIds.push(worktreeId)
    }

    /** @type {AgentView[]} */
    const sessionAgents = []
    const pubAgents = new Map((pub?.agents ?? []).map(a => [a.id, a]))
    /** @type {SubagentMeta[]} */
    let metas = []
    const isRecent = now - lastActivityAt <= META_WINDOW_MS || life.lifecycle === 'running'
    if (cliSessionId && isRecent) {
      try {
        const cwds = [d?.cwd, pub?.cwd].filter(c => typeof c === 'string')
        metas = await readSubagents($, readers.subagents, paths.sep, paths.projectsDir, cwds, cliSessionId, String(lastActivityAt), now)
        metaKeys.add(cliSessionId)
      } catch (error) {
        errors.push(`subagents ${cliSessionId}: ${errorText(error)}`)
      }
    }
    const metaById = new Map(metas.map(m => [m.id, m]))
    const ids = new Set([...pubAgents.keys(), ...metaById.keys()])
    for (const agentId of ids) {
      const p = pubAgents.get(agentId)
      const m = metaById.get(agentId)
      const last = Math.max(p?.lastActivityAt ?? 0, m?.lastActivityAt ?? 0) || null
      const life2 = agentLifecycle(p?.status ?? null, m?.finished ?? null, last, now, staleMs, p ? 'mod-events' : 'subagent-meta')
      const lifecycle = livePub || !p ? life2 : agentLifecycle(null, m?.finished ?? (p.finishedAt ? true : null), last, now, staleMs, 'subagent-meta')
      const tools = (pub?.tools ?? []).filter(t => t.agentId === agentId)
      const lastTool = tools.at(-1)
      sessionAgents.push({
        key: `${key}/${agentId}`,
        id: agentId,
        sessionKey: key,
        parentKey: p?.parentId ? `${key}/${p.parentId}` : null,
        type: p?.type && p.type !== 'agent' ? p.type : m?.type ?? 'agent',
        description: p?.description || m?.description || '',
        name: p?.name ?? null,
        model: p?.model ?? m?.model ?? null,
        lifecycle: lifecycle.lifecycle,
        evidence: lifecycle.evidence,
        phase: phaseFromTools(pub?.tools ?? [], now, { isPlanMode: false, waiting: null, agentId }).phase,
        activity: lastTool && lifecycle.lifecycle === 'running' ? describeTool(lastTool.category, lastTool.target) : null,
        startedAt: p?.startedAt ?? null,
        lastActivityAt: last,
        finishedAt: p?.finishedAt ?? null,
        recent: tools
          .slice(-6)
          .reverse()
          .map(t => ({ at: t.at, kind: /** @type {const} */ ('tool'), text: `${describeTool(t.category, t.target)}${t.isError ? ' (failed)' : ''}` })),
      })
    }
    sessionAgents.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    const keptAgents = sessionAgents.slice(0, MAX_AGENTS_PER_SESSION)
    for (const agent of keptAgents) if (agent.lifecycle === 'running') project.activeAgents += 1
    agents.push(...keptAgents)
    const effective = withRunningAgents(life, keptAgents)
    const waitsOnAgents = effective.lifecycle !== life.lifecycle
    if (waitsOnAgents) activity = effective.evidence.detail

    sessions.push({
      key,
      localId: d?.localId ?? null,
      cliSessionId,
      title,
      projectId: id.projectId,
      worktreeId,
      environment: environmentOf(d, pub),
      canOpen: d !== null,
      canMessage: messageBlock === null,
      messageBlock,
      cwd: d?.cwd ?? pub?.cwd ?? null,
      branch,
      model: pub?.model ?? d?.model ?? null,
      effort: d?.effort ?? null,
      createdAt: d?.createdAt ?? pub?.startedAt ?? null,
      lastActivityAt,
      lifecycle: effective.lifecycle,
      lifecycleEvidence: effective.evidence,
      stateSince: effective.since,
      finishedAt: livePub?.turn.isRunning || d?.isMidTurn || waitsOnAgents ? null : Math.max(pub?.turn.endedAt ?? 0, d?.lastTurnEdgeAt ?? 0) || null,
      phase: phase.phase,
      phaseEvidence: phase.evidence,
      summary,
      activity,
      attention: effective.attention,
      attentionText: effective.attentionText,
      isPlanMode,
      context: pub?.context
        ? {
            percent: pub.context.percent,
            tokens: pub.context.tokens,
            window: pub.context.window,
            evidence: evidence('mod-events', 'observed', pub.context.measuredAt, 'session.measure'),
          }
        : { percent: null, tokens: null, window: null, evidence: evidence('none', 'unknown', null, 'session does not run this mod') },
      cost: typeof pub?.cost === 'number' && Number.isFinite(pub.cost) && pub.cost >= 0 ? pub.cost : null,
      turns: d?.completedTurns ?? null,
      prs: d?.prs ?? [],
      agentKeys: keptAgents.map(a => a.key),
      timeline: timelineOf(d, pub),
      stuck: livePub ? stuckOf(livePub.tools, now, life.lifecycle, life.since) : null,
      projectSource: decided.source,
      lastFocusedAt: d?.lastFocusedAt ?? null,
      remoteControl: d?.remoteControl ?? null,
      ...(renamed !== null && renamed !== ownTitle ? { renamedFrom: ownTitle } : {}),
      ...(tint ? { tint: /** @type {any} */ (tint) } : {}),
      hasSuggestion: d?.hasSuggestion === true,
      parent: d?.parent ?? null,
      lastReport: d?.lastReport ?? null,
      failure: d?.failure ?? null,
      publisher: pub ? { modVersion: pub.modVersion, engineVersion: pub.engineVersion, heartbeatAt: pub.heartbeatAt, endedAt: pub.endedAt, pane: pub.pane ?? null, inbox: pub.inbox ?? null, ...(pub.replyProtocol === 2 ? { replyProtocol: 2 } : {}), ...(pub.stopProtocol === 1 ? { stopProtocol: 1 } : {}), ...(pub.agentProtocol === 1 ? { agentProtocol: 1 } : {}), ...(pub.errors ? { errors: pub.errors } : {}) } : null,
    })
  }
  forgetSubagents(readers.subagents, metaKeys)
  pruneBranchCache(readers.branches, now)

  const projectList = [...projects.values()].map(p => (ctx.projectTints?.[p.id] ? { ...p, tint: /** @type {any} */ (ctx.projectTints[p.id]) } : p))
  const worktreeList = [...worktrees.values()]

  const isLive = (/** @type {PublishedSession} */ p) => p.endedAt === null && now - p.updatedAt < LIVE_WINDOW_MS
  /** @type {SourceHealth} */
  const sources = {
    desktop: { ok: desktop.error === null, files: desktop.files, parsed: desktop.parsed, failed: desktop.failed, skipped: desktop.skipped, error: desktop.error },
    publishers: {
      files: readers.publishers.count,
      live: [...pubById.values()].filter(isLive).length,
      failed: readers.publishers.failed,
    },
    subagents: { metas: agents.length, failed: readers.subagents.failed },
    errors,
  }

  return {
    schema: 1,
    generatedAt: now,
    generator: me,
    modVersion: MOD_VERSION,
    projects: projectList,
    worktrees: worktreeList,
    sessions,
    agents,
    usage: usageOf(pubById.values(), now),
    sources,
    timings: { aggregateMs: Date.now() - started, sessions: sessions.length, agents: agents.length },
  }
}
