import type { EngineInterface, Timer } from 'claude-code'

import type { ErrorTrace, ErrorWhere, InboxStats, PublishedAgent, PublishedSession, TimelineEntry, ToolRecord } from '../../types'
import { MOD_VERSION } from '../../shared/constants.js'
import { errorText, joinWith, type Paths } from '../paths'
import { categorizeTool, describeTool, withoutCredentials } from '../../shared/aggregate/redact.js'

const WRITE_DEBOUNCE_MS = 5_000
const HEARTBEAT_MS = 30_000
const IDLE_BEAT_MS = 120_000
const AGENT_SETTLE_MS = 2 * HEARTBEAT_MS
const LIVE_AGENT_STATUSES: readonly string[] = ['pending', 'running', 'waiting']
const MAX_TOOLS = 40
const MAX_TIMELINE = 40
const MAX_AGENTS = 60
const MAX_DESCRIPTION = 120

/**
 * This session's own record: what its hooks observe, written to
 * `sessions/<cliSessionId>.json` so the Orbit server can read it.
 * Only redacted facts are kept: tool names, file basenames, program names.
 */
export type PublisherState = {
  paths: Paths | null
  record: PublishedSession | null
  writes: number
  lastError: string | null
  writeTimer: Timer | null
  heartbeat: Timer | null
  pendingTools: Map<string, { at: number; tool: string; agentId: string | null }>
  waitFor: Set<string> | null
  errors: ErrorTrace | null
}

const freshPublisher = (): PublisherState => ({
  paths: null,
  record: null,
  writes: 0,
  lastError: null,
  writeTimer: null,
  heartbeat: null,
  pendingTools: new Map(),
  waitFor: null,
  errors: null,
})

export const pub: PublisherState = freshPublisher()

/**
 * Puts the publisher back as a new module instance starts it: timers
 * cancelled, no record, no error trace. For tests that import this module
 * directly (the kit shares one instance across a file's tests); the mod
 * never calls it, since a `/clear` keeps the error trace (E-29).
 */
export function resetPublisher(): void {
  pub.writeTimer?.cancel()
  pub.heartbeat?.cancel()
  Object.assign(pub, freshPublisher())
}

const ERROR_KIND = /^[A-Za-z0-9_-]{1,40}$/

/** The error's name or code when it is a plain identifier, never its message (it can hold paths or prompt text). */
function errorKind(error: unknown): string {
  const e = error as { name?: unknown; code?: unknown } | null
  if (e && typeof e.code === 'string' && ERROR_KIND.test(e.code)) return e.code
  if (e && typeof e.name === 'string' && ERROR_KIND.test(e.name)) return e.name
  return 'Error'
}

/**
 * Counts one failure of this session's mod (E-29) into its record: kept in
 * module memory too, so a publisher restart (`/clear`, resume) carries it
 * over, and never cleared by a later success. Written with the next flush.
 */
export async function recordError($: EngineInterface, where: ErrorWhere, error: unknown): Promise<void> {
  const now = await $.clock.now().catch(() => Date.now())
  pub.errors = { count: (pub.errors?.count ?? 0) + 1, lastAt: now, where, kind: errorKind(error) }
  const errors = pub.errors
  if (pub.record) pub.record = { ...pub.record, errors }
}

export function isPublishing(): boolean {
  return pub.record !== null && pub.record.endedAt === null
}


function push<T>(list: T[], item: T, max: number): T[] {
  const next = [...list, item]
  return next.length > max ? next.slice(next.length - max) : next
}

function mutate(now: number, change: (record: PublishedSession) => PublishedSession): void {
  if (!pub.record) return
  pub.record = { ...change(pub.record), updatedAt: now, heartbeatAt: now }
}

function finished(record: ToolRecord, isError: boolean): ToolRecord {
  const { pending: _pending, ...rest } = record
  return { ...rest, isError }
}

function note(now: number, kind: TimelineEntry['kind'], text: string): void {
  mutate(now, r => ({ ...r, timeline: push(r.timeline, { at: now, kind, text }, MAX_TIMELINE) }))
}

function touchAgent(now: number, agentId: string, patch: Partial<PublishedAgent>): void {
  mutate(now, r => {
    const existing = r.agents.find(a => a.id === agentId)
    const base: PublishedAgent = existing ?? {
      id: agentId,
      parentId: null,
      type: 'agent',
      description: '',
      name: null,
      model: null,
      status: 'running',
      startedAt: now,
      lastActivityAt: now,
      finishedAt: null,
    }
    const next = { ...base, lastActivityAt: now, ...patch }
    return { ...r, agents: [...r.agents.filter(a => a.id !== agentId), next].slice(-MAX_AGENTS) }
  })
}

export async function publishFlush($: EngineInterface): Promise<void> {
  if (!pub.record || !pub.paths) return
  try {
    await $.fs.write(joinWith(pub.paths.sep, pub.paths.sessionsDir, `${pub.record.cliSessionId}.json`), JSON.stringify(pub.record))
    pub.writes += 1
    pub.lastError = null
  } catch (error) {
    pub.lastError = errorText(error)
    await recordError($, 'publish', error)
  }
}

/** Writes at once, folding in any debounced write: turn edges are what readers wait for. */
async function flushNow($: EngineInterface): Promise<void> {
  pub.writeTimer?.cancel()
  pub.writeTimer = null
  await publishFlush($)
}

function schedule($: EngineInterface): void {
  if (pub.writeTimer) return
  pub.writeTimer = $.clock.after(WRITE_DEBOUNCE_MS, () => {
    pub.writeTimer = null
    void publishFlush($)
  })
}

async function refreshAgents($: EngineInterface): Promise<void> {
  if (!pub.record) return
  try {
    const listed = await $.agent.list()
    const now = await $.clock.now()
    mutate(now, r => {
      const byId = new Map(r.agents.map(a => [a.id, a]))
      for (const info of listed) {
        const existing = byId.get(info.id)
        const isDone = info.status === 'completed' || info.status === 'failed' || info.status === 'killed'
        byId.set(info.id, {
          id: info.id,
          parentId: info.parentId ?? existing?.parentId ?? null,
          type: info.type || existing?.type || 'agent',
          description: (info.description || existing?.description || '').slice(0, MAX_DESCRIPTION),
          name: info.name ?? existing?.name ?? null,
          model: existing?.model ?? null,
          status: info.status,
          startedAt: existing?.startedAt ?? now,
          lastActivityAt: existing?.lastActivityAt ?? now,
          finishedAt: isDone ? existing?.finishedAt ?? now : null,
        })
      }
      return { ...r, agents: [...byId.values()].slice(-MAX_AGENTS) }
    })
  } catch (error) {
    pub.lastError = errorText(error)
  }
}

async function beat($: EngineInterface): Promise<void> {
  const record = pub.record
  if (!record || record.endedAt !== null) return
  const now = await $.clock.now()
  const hasRunningAgents = record.agents.some(a => LIVE_AGENT_STATUSES.includes(a.status) || (a.finishedAt !== null && now - a.finishedAt < AGENT_SETTLE_MS))
  if (!record.turn.isRunning && !hasRunningAgents && now - record.heartbeatAt < IDLE_BEAT_MS - HEARTBEAT_MS / 2) return
  if (hasRunningAgents) await refreshAgents($)
  mutate(now, r => r)
  schedule($)
}

export async function publishStart($: EngineInterface, paths: Paths, cwd: string, entrypoint: string | null): Promise<void> {
  pub.paths = paths
  const now = await $.clock.now()
  const id = await $.session.id()
  const model = await $.session.model().catch(() => null)
  const version = await $.session.version().catch(() => null)
  const repo = await $.session.repo().catch(() => null)
  pub.record = {
    schema: 1,
    cliSessionId: id,
    modVersion: MOD_VERSION,
    engineVersion: version?.version ?? null,
    entrypoint,
    cwd,
    repoRoot: repo?.root ?? null,
    repoRemote: repo?.remote ? withoutCredentials(repo.remote) : null,
    repoName: repo?.name ?? null,
    model,
    startedAt: now,
    updatedAt: now,
    heartbeatAt: now,
    endedAt: null,
    endReason: null,
    turn: { isRunning: false, startedAt: null, endedAt: null, lastReason: null },
    waiting: null,
    context: null,
    cost: null,
    rateLimits: null,
    usageAt: null,
    idleBeatMs: IDLE_BEAT_MS,
    replyProtocol: 2,
    stopProtocol: 1,
    agentProtocol: 1,
    ...(pub.errors ? { errors: pub.errors } : {}),
    tools: [],
    timeline: [{ at: now, kind: 'note', text: 'Session started' }],
    agents: [],
  }
  pub.pendingTools.clear()
  pub.waitFor = null
  pub.heartbeat?.cancel()
  pub.heartbeat = $.clock.every(HEARTBEAT_MS, () => void beat($))
  await publishFlush($)
}

export async function publishTurnStart($: EngineInterface, agentId: string | undefined): Promise<void> {
  if (!isPublishing()) return
  const now = await $.clock.now()
  if (agentId === undefined) {
    mutate(now, r => ({ ...r, turn: { ...r.turn, isRunning: true, startedAt: now }, waiting: null }))
    note(now, 'turn', 'Turn started')
  } else {
    touchAgent(now, agentId, { status: 'running' })
  }
  if (agentId === undefined) await flushNow($)
  else schedule($)
}

export async function publishTurnComplete($: EngineInterface, agentId: string | undefined, reason: string): Promise<void> {
  if (!isPublishing()) return
  const now = await $.clock.now()
  if (agentId === undefined) {
    mutate(now, r => ({ ...r, turn: { isRunning: false, startedAt: r.turn.startedAt, endedAt: now, lastReason: reason }, waiting: null }))
    note(now, 'turn', reason === 'answer' ? 'Turn finished' : `Turn ended: ${reason}`)
    mutate(now, r => ({ ...r, tools: r.tools.map(t => (t.pending ? finished(t, t.isError) : t)) }))
    pub.pendingTools.clear()
    pub.waitFor = null
    await refreshAgents($)
  } else {
    const status = reason === 'error' || reason === 'refusal' ? 'failed' : reason === 'aborted' ? 'killed' : 'completed'
    touchAgent(now, agentId, {})
    await refreshAgents($)
    const agent = pub.record?.agents.find(a => a.id === agentId)
    if (agent && (agent.status === 'running' || agent.status === 'pending')) touchAgent(now, agentId, { status, finishedAt: now })
    note(now, 'agent', `Subagent ${agent?.status ?? status}: ${agent?.description || agentId}`)
  }
  if (agentId === undefined) await flushNow($)
  else schedule($)
}

export async function publishAgentSpawned(
  $: EngineInterface,
  input: { description: string; subagentType: string; parentAgentId: string | undefined },
  result: { agentId?: string | undefined; model?: string | undefined },
): Promise<void> {
  if (!isPublishing() || !result.agentId) return
  const now = await $.clock.now()
  touchAgent(now, result.agentId, {
    parentId: input.parentAgentId ?? null,
    type: input.subagentType || 'agent',
    description: input.description.slice(0, MAX_DESCRIPTION),
    model: result.model ?? null,
    status: 'running',
    startedAt: now,
    finishedAt: null,
  })
  note(now, 'agent', `Started subagent: ${input.description.slice(0, 80)}`)
  schedule($)
}

export async function publishToolStart(
  $: EngineInterface,
  tool: string,
  toolUseId: string,
  input: Record<string, unknown>,
  agentId: string | undefined,
): Promise<void> {
  if (!isPublishing()) return
  const now = await $.clock.now()
  const { category, target } = categorizeTool(tool, input)
  const record: ToolRecord = { at: now, tool, category, target, isError: false, agentId: agentId ?? null, pending: true }
  pub.pendingTools.set(toolUseId, { at: now, tool, agentId: agentId ?? null })
  const isQuestion = category === 'question' && agentId === undefined
  mutate(now, r => ({
    ...r,
    tools: push(r.tools, record, MAX_TOOLS),
    waiting: isQuestion ? { kind: 'question', since: now, tool } : r.waiting,
  }))
  if (agentId !== undefined) touchAgent(now, agentId, {})
  if (isQuestion) {
    note(now, 'state', 'Asked you a question')
    await publishFlush($)
    return
  }
  schedule($)
}

export async function publishToolEnd($: EngineInterface, tool: string, toolUseId: string, isError: boolean): Promise<void> {
  if (!isPublishing()) return
  const now = await $.clock.now()
  const pending = pub.pendingTools.get(toolUseId)
  pub.pendingTools.delete(toolUseId)
  const matches = (t: ToolRecord) => pending !== undefined && t.at === pending.at && t.tool === tool && t.agentId === pending.agentId
  const isWaitedCall = pub.waitFor === null || pub.waitFor.delete(toolUseId)
  mutate(now, r => {
    const isWaitOver = r.waiting !== null && (r.waiting.kind === 'permission' ? isWaitedCall && (pub.waitFor?.size ?? 0) === 0 : tool === 'AskUserQuestion')
    if (isWaitOver) pub.waitFor = null
    return { ...r, tools: r.tools.map(t => (matches(t) ? finished(t, isError) : t)), waiting: isWaitOver ? null : r.waiting }
  })
  if (isError) {
    const record = pub.record?.tools.find(matches)
    note(now, 'tool', `${record ? describeTool(record.category, record.target) : tool} failed`)
  }
  schedule($)
}

export async function publishPermission($: EngineInterface, tool: string | null): Promise<void> {
  if (!isPublishing()) return
  const now = await $.clock.now()
  const waited = [...pub.pendingTools].filter(([, call]) => tool === null || call.tool === tool).map(([id]) => id)
  pub.waitFor = waited.length > 0 ? new Set(waited) : null
  mutate(now, r => ({ ...r, waiting: { kind: 'permission', since: now, tool } }))
  note(now, 'state', `Waiting for permission${tool ? `: ${tool}` : ''}`)
  await publishFlush($)
}

type Measure = {
  context: { percent?: number | undefined; tokens?: number | undefined; window: number }
  rateLimits?: readonly { kind: string; percentUsed: number; resetsAt?: string | undefined }[] | undefined
  cost?: { usd: number } | undefined
}

/** Puts this session's reply-inbox counts (never text) into its record. */
export async function publishInbox($: EngineInterface, stats: InboxStats): Promise<void> {
  if (!pub.record || !isPublishing()) return
  mutate(await $.clock.now(), r => ({ ...r, inbox: stats }))
  schedule($)
}

/**
 * Records the context window, cost and rate limits a measurement reports,
 * and schedules a write only when one of them moved as published (context
 * by whole percent, cost by cent, limits by whole percent).
 */
export async function publishMeasure($: EngineInterface, measure: Measure): Promise<void> {
  const record = pub.record
  if (!record || !isPublishing()) return
  const { context, rateLimits, cost } = measure
  const nextContext = { percent: context.percent ?? null, tokens: context.tokens ?? null, window: context.window ?? null }
  const nextCost = typeof cost?.usd === 'number' && Number.isFinite(cost.usd) ? Math.round(cost.usd * 100) / 100 : record.cost ?? null
  const nextLimits = rateLimits
    ? rateLimits
        .filter(l => typeof l.kind === 'string' && Number.isFinite(l.percentUsed))
        .slice(0, 4)
        .map(l => ({ kind: l.kind.slice(0, 40), percentUsed: Math.round(l.percentUsed), resetsAt: typeof l.resetsAt === 'string' ? l.resetsAt.slice(0, 40) : null }))
    : record.rateLimits ?? null
  const isSame =
    record.context?.percent === nextContext.percent &&
    record.context?.window === nextContext.window &&
    record.cost === nextCost &&
    JSON.stringify(record.rateLimits ?? null) === JSON.stringify(nextLimits)
  if (isSame) return
  const now = await $.clock.now()
  mutate(now, r => ({ ...r, context: { ...nextContext, measuredAt: now }, cost: nextCost, rateLimits: nextLimits, usageAt: now }))
  schedule($)
}

export async function publishModel($: EngineInterface): Promise<void> {
  if (!pub.record) return
  const model = await $.session.model().catch(() => null)
  if (model && model !== pub.record.model) {
    mutate(await $.clock.now(), r => ({ ...r, model }))
    schedule($)
  }
}

export async function publishEnd($: EngineInterface, reason: string): Promise<void> {
  if (!pub.record) return
  const now = await $.clock.now()
  mutate(now, r => ({ ...r, endedAt: now, endReason: reason }))
  note(now, 'note', `Session ended (${reason})`)
  pub.writeTimer?.cancel()
  pub.writeTimer = null
  pub.heartbeat?.cancel()
  pub.heartbeat = null
  await publishFlush($)
}
