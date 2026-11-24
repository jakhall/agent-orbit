import type { AgentView, Evidence, ProjectView, PublishedSession, SessionView, Snapshot, WorktreeView } from '../types'
import { CONVERSATION_ROWS, pageRows, textLines } from '../shared/conversation.js'
import { layoutGraph } from '../shared/layout.js'

export const NOW = 1_800_000_000_000

export const EV: Evidence = { source: 'desktop-metadata', confidence: 'observed', observedAt: NOW, detail: null }

export function session(key: string, patch: Partial<SessionView> = {}): SessionView {
  return {
    key,
    localId: key.startsWith('local_') ? key : null,
    cliSessionId: `cli-${key}`,
    title: `Session ${key}`,
    projectId: 'c:\\repo\\app',
    worktreeId: 'c:\\repo\\app',
    environment: 'desktop',
    canOpen: key.startsWith('local_'),
    canMessage: true,
    cwd: 'C:\\repo\\app',
    branch: 'main',
    model: 'claude-opus-5-5',
    effort: null,
    createdAt: NOW - 3_600_000,
    lastActivityAt: NOW - 60_000,
    lifecycle: 'idle',
    lifecycleEvidence: EV,
    stateSince: NOW - 60_000,
    finishedAt: NOW - 60_000,
    phase: 'unknown',
    phaseEvidence: { ...EV, source: 'none', confidence: 'unknown' },
    summary: 'Working on things',
    activity: null,
    attention: null,
    attentionText: null,
    isPlanMode: false,
    context: { percent: null, tokens: null, window: null, evidence: { ...EV, source: 'none', confidence: 'unknown' } },
    cost: null,
    turns: 3,
    prs: [],
    agentKeys: [],
    timeline: [],
    publisher: null,
    ...patch,
  }
}

export function agent(sessionKey: string, id: string, patch: Partial<AgentView> = {}): AgentView {
  return {
    key: `${sessionKey}/${id}`,
    id,
    sessionKey,
    parentKey: null,
    type: 'general-purpose',
    description: `Agent ${id}`,
    name: null,
    model: 'claude-sonnet-5-5',
    lifecycle: 'running',
    evidence: EV,
    phase: 'researching',
    activity: 'Reading a.ts',
    startedAt: NOW - 120_000,
    lastActivityAt: NOW - 5_000,
    finishedAt: null,
    recent: [],
    ...patch,
  }
}

export function buildSnapshot(sessions: SessionView[], agents: AgentView[] = [], positions = {}): Snapshot {
  const projects = new Map<string, ProjectView>()
  const worktrees = new Map<string, WorktreeView>()
  for (const s of sessions) {
    const p = projects.get(s.projectId) ?? {
      id: s.projectId,
      name: s.projectId.split('\\').at(-1) ?? s.projectId,
      root: s.projectId,
      remote: null,
      sessionKeys: [],
      worktreeIds: [],
      lastActivityAt: 0,
      activeAgents: 0,
    }
    p.sessionKeys.push(s.key)
    p.lastActivityAt = Math.max(p.lastActivityAt, s.lastActivityAt)
    if (s.worktreeId) {
      const w = worktrees.get(s.worktreeId) ?? { id: s.worktreeId, projectId: s.projectId, path: s.worktreeId, isMain: s.worktreeId === s.projectId, branch: s.branch, sessionKeys: [] }
      w.sessionKeys.push(s.key)
      worktrees.set(s.worktreeId, w)
      if (!p.worktreeIds.includes(s.worktreeId)) p.worktreeIds.push(s.worktreeId)
    }
    projects.set(s.projectId, p)
  }
  const withAgents = sessions.map(s => ({ ...s, agentKeys: agents.filter(a => a.sessionKey === s.key).map(a => a.key) }))
  const projectList = [...projects.values()]
  const worktreeList = [...worktrees.values()]
  const graph = layoutGraph({ projects: projectList, worktrees: worktreeList, sessions: withAgents, agents }, positions)
  return {
    schema: 2,
    generatedAt: NOW,
    generator: 'orbit-server',
    serverVersion: 'test',
    seq: 1,
    bootId: '0123456789abcdef',
    projects: projectList,
    worktrees: worktreeList,
    sessions: withAgents,
    agents,
    graph,
    usage: null,
    sources: {
      desktop: { ok: true, files: sessions.length, parsed: sessions.length, failed: 0, error: null },
      publishers: { files: 0, live: 0, failed: 0 },
      subagents: { metas: agents.length, failed: 0 },
      errors: [],
    },
    timings: { aggregateMs: 1, layoutMs: 1, sessions: sessions.length, agents: agents.length },
  }
}

/** A synthetic workload: `projects` projects, `sessions` sessions, `agentsPer` subagents each. */
export function synthetic(projects: number, sessions: number, agentsPer: number): Snapshot {
  const list: SessionView[] = []
  const agents: AgentView[] = []
  const lifecycles = ['running', 'idle', 'completed', 'waiting-user', 'stale'] as const
  for (let i = 0; i < sessions; i += 1) {
    const key = `local_${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`
    const lifecycle = lifecycles[i % lifecycles.length] ?? 'idle'
    list.push(
      session(key, {
        projectId: `c:\\repos\\project-${i % projects}`,
        worktreeId: `c:\\repos\\project-${i % projects}${i % 7 === 0 ? `-wt${i}` : ''}`,
        lifecycle,
        attention: lifecycle === 'waiting-user' ? 'question' : null,
        createdAt: NOW - (sessions - i) * 60_000,
        lastActivityAt: NOW - i * 30_000,
      }),
    )
    for (let j = 0; j < agentsPer; j += 1) agents.push(agent(key, `a${i}x${j}`, { startedAt: NOW - j * 1000, lifecycle: j % 3 === 0 ? 'running' : 'completed' }))
  }
  return buildSnapshot(list, agents)
}

export function pub(patch: Partial<PublishedSession> = {}): PublishedSession {
  return {
    schema: 1,
    cliSessionId: 'cli-1',
    modVersion: '1.0.0',
    engineVersion: '2.1.317',
    entrypoint: 'claude-desktop',
    cwd: 'C:\\repo',
    repoRoot: 'C:\\repo',
    repoRemote: null,
    repoName: null,
    model: 'claude-opus-5-5',
    startedAt: NOW - 600_000,
    updatedAt: NOW - 1_000,
    heartbeatAt: NOW - 1_000,
    endedAt: null,
    endReason: null,
    turn: { isRunning: false, startedAt: null, endedAt: null, lastReason: null },
    waiting: null,
    context: null,
    tools: [],
    timeline: [],
    agents: [],
    ...patch,
  }
}

const BUCKET_CYCLE = ['needs-you', 'working', 'review', 'idle', 'failed', 'idle'] as const
const BUCKET_REASON = { 'needs-you': 'Asked you a question', working: 'Running Bash', review: 'Finished: ready for review', idle: 'Idle', failed: 'Failed: tool error' }

/** `count` live sessions in `projects` projects, cycling through every D-4 bucket, with a server `status` each (schema 2). */
export function bucketed(count: number, projects: number): Snapshot {
  const sessions: SessionView[] = []
  for (let i = 0; i < count; i += 1) {
    const bucket = BUCKET_CYCLE[i % BUCKET_CYCLE.length] ?? 'idle'
    const key = `local_${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
    sessions.push(
      session(key, {
        title: `Session ${i} working on feature ${i % 17}`,
        projectId: `c:\\repos\\project-${i % projects}`,
        worktreeId: `c:\\repos\\project-${i % projects}`,
        lifecycle: bucket === 'working' ? 'running' : 'idle',
        attention: bucket === 'needs-you' ? 'question' : null,
        attentionText: bucket === 'needs-you' ? 'Asked you a question' : null,
        createdAt: NOW - (count - i) * 60_000,
        lastActivityAt: NOW - i * 30_000,
        status: { bucket, reason: BUCKET_REASON[bucket], since: NOW - (i + 1) * 30_000, isObserved: true },
      } as Partial<SessionView>),
    )
  }
  return buildSnapshot(sessions)
}

/** The readable end of transcript text, as the server pages it: its last `CONVERSATION_ROWS` rows and the turn count. */
export function rowsOfTranscript(text: string, base = 0) {
  const { rows, turns } = pageRows(textLines(text, base), base, { isCut: false, limit: CONVERSATION_ROWS })
  return { rows, turns }
}
