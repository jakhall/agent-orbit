// @ts-check

import { TURN_EDGE_SLACK_MS } from './desktop.js'

/** @typedef {import('../../types').AttentionKind} AttentionKind */
/** @typedef {import('../../types').Evidence} Evidence */
/** @typedef {import('../../types').Lifecycle} Lifecycle */
/** @typedef {import('../../types').MessageBlock} MessageBlock */
/** @typedef {import('../../types').Phase} Phase */
/** @typedef {import('../../types').PublishedSession} PublishedSession */
/** @typedef {import('../../types').PublishedWaiting} PublishedWaiting */
/** @typedef {import('../../types').StuckView} StuckView */
/** @typedef {import('../../types').ToolCategory} ToolCategory */
/** @typedef {import('../../types').ToolRecord} ToolRecord */
/** @typedef {import('./desktop.js').DesktopSession} DesktopSession */

const RECENT_TOOLS_MS = 10 * 60_000

/**
 * @param {Evidence['source']} source
 * @param {Evidence['confidence']} confidence
 * @param {number | null} observedAt
 * @param {string | null} [detail]
 * @returns {Evidence}
 */
export function evidence(source, confidence, observedAt, detail = null) {
  return { source, confidence, observedAt, detail }
}

/** @type {Partial<Record<ToolCategory, Phase>>} */
const STRONG = {
  plan: 'planning',
  question: 'awaiting-response',
  test: 'testing',
  merge: 'merging',
  'git-write': 'merging',
  review: 'reviewing',
  edit: 'implementing',
  read: 'researching',
  search: 'researching',
  web: 'researching',
}

/**
 * @param {string} target
 * @returns {Phase}
 */
function agentPhase(target) {
  if (/review|audit|critique/i.test(target)) return 'reviewing'
  if (/test|verify|validat/i.test(target)) return 'testing'
  if (/research|explore|investigat|find|search|look/i.test(target)) return 'researching'
  if (/plan|design/i.test(target)) return 'planning'
  if (/fix|debug|diagnos/i.test(target)) return 'debugging'
  return 'implementing'
}

/**
 * Deterministic phase from the newest tool calls (newest first wins), with the
 * debugging rule: an edit that follows a failed test run in the last few calls.
 * @param {readonly ToolRecord[]} tools
 * @param {number} now
 * @param {{ isPlanMode: boolean, waiting: PublishedWaiting | null, agentId: string | null }} options
 * @returns {{ phase: Phase, evidence: Evidence }}
 */
export function phaseFromTools(tools, now, options) {
  if (options.waiting?.kind === 'question' && options.agentId === null) {
    return { phase: 'awaiting-response', evidence: evidence('mod-events', 'observed', options.waiting.since, 'AskUserQuestion open') }
  }
  if (options.isPlanMode && options.agentId === null) {
    return { phase: 'planning', evidence: evidence('desktop-metadata', 'observed', null, 'plan mode is on') }
  }
  const recent = tools
    .filter(t => t.agentId === options.agentId && now - t.at <= RECENT_TOOLS_MS)
    .slice(-12)
    .reverse()
  for (let i = 0; i < recent.length; i += 1) {
    const record = recent[i]
    if (!record) continue
    const phase = record.category === 'agent' ? agentPhase(record.target) : STRONG[record.category]
    if (!phase) continue
    if (phase === 'implementing') {
      const failedTest = recent.slice(i + 1, i + 7).find(t => t.category === 'test' && t.isError)
      if (failedTest) {
        return {
          phase: 'debugging',
          evidence: evidence('mod-events', 'inferred', record.at, `edited ${record.target} after a failing test run`),
        }
      }
    }
    return { phase, evidence: evidence('mod-events', 'inferred', record.at, `${record.tool} ${record.target}`.trim()) }
  }
  if (recent.length > 0) {
    const last = recent[0]
    return { phase: 'general', evidence: evidence('mod-events', 'inferred', last?.at ?? null, last ? `${last.tool}` : null) }
  }
  return { phase: 'unknown', evidence: evidence('none', 'unknown', null) }
}

/**
 * @param {DesktopSession} desktop
 * @returns {{ phase: Phase, evidence: Evidence }}
 */
export function phaseFromDesktop(desktop) {
  if (desktop.permissionMode === 'plan') {
    return { phase: 'planning', evidence: evidence('desktop-metadata', 'observed', desktop.lastActivityAt, 'plan mode is on') }
  }
  if (desktop.summary.category === 'blocked') {
    return { phase: 'blocked', evidence: evidence('desktop-summary', 'inferred', desktop.lastActivityAt, desktop.summary.detail) }
  }
  if (desktop.summary.needsAction) {
    return { phase: 'awaiting-response', evidence: evidence('desktop-summary', 'inferred', desktop.lastActivityAt, desktop.summary.needsAction) }
  }
  return { phase: 'unknown', evidence: evidence('none', 'unknown', null) }
}

/**
 * @typedef {object} LifecycleInput
 * @property {DesktopSession | null} desktop
 * @property {PublishedSession | null} publisher
 * @property {number} now
 * @property {number} staleMs
 */

/**
 * @typedef {object} LifecycleResult
 * @property {Lifecycle} lifecycle
 * @property {Evidence} evidence
 * @property {AttentionKind | null} attention
 * @property {string | null} attentionText
 * @property {number | null} since When this lifecycle began: the wait, the turn, the silence, or the last turn's end.
 */

const HEARTBEAT_GRACE_MS = 90_000
const IDLE_BEAT_GRACE_MS = 30_000

/**
 * When a record that never ended stopped beating, or null while it beats (or
 * declares no idle heartbeat, as records before 1.16 do): two missed idle
 * beats plus a grace mean the process is gone without a `session.end`.
 * @param {PublishedSession} publisher
 * @param {number | undefined} now
 * @returns {number | null}
 */
function silentSince(publisher, now) {
  if (now === undefined || publisher.endedAt !== null || typeof publisher.idleBeatMs !== 'number' || publisher.idleBeatMs <= 0) return null
  return now - publisher.heartbeatAt > 2 * publisher.idleBeatMs + IDLE_BEAT_GRACE_MS ? publisher.heartbeatAt : null
}

/**
 * Whether the session's process has stopped: its newest publisher record has
 * `endedAt`, or declares an idle heartbeat it stopped keeping, and nothing
 * since shows a process again. A new start of the same CLI session (a desktop
 * resume) rewrites the record with `endedAt: null`, so an ended record is
 * never older than the last start in it; a desktop turn edge or typed prompt
 * more than a few seconds after the end, or turn activity in the transcript
 * (which `withTranscriptActivity` only finds after the end), means a process
 * ran again before or without republishing. An ended record's heartbeat is
 * not used: its process can still touch it (a model change).
 * @param {PublishedSession | null} publisher
 * @param {DesktopSession | null} desktop
 * @param {number} [now]
 * @returns {boolean}
 */
export function hasProcessEnded(publisher, desktop, now) {
  if (!publisher) return false
  const endedAt = publisher.endedAt ?? silentSince(publisher, now)
  if (endedAt === null || publisher.startedAt > endedAt) return false
  if (!desktop) return true
  if (desktop.isMidTurn && desktop.midTurnSource === 'transcript') return false
  return Math.max(desktop.lastTurnEdgeAt, desktop.turnStartedAt ?? 0) <= endedAt + TURN_EDGE_SLACK_MS
}

/**
 * Why Orbit cannot message a session, or null when it can: no CLI id to
 * address, or a stopped process (`asleep` for a desktop session, which the
 * desktop wakes on its next message; `ended` otherwise). Sessions without a
 * publisher record are messageable whenever they have an id.
 * @param {string | null} cliSessionId
 * @param {PublishedSession | null} publisher
 * @param {DesktopSession | null} desktop
 * @param {number} [now]
 * @returns {MessageBlock | null}
 */
export function messageBlockOf(cliSessionId, publisher, desktop, now) {
  if (cliSessionId === null) return 'no-id'
  if (hasProcessEnded(publisher, desktop, now)) return desktop ? 'asleep' : 'ended'
  return null
}

/**
 * When a session's mod last saw it do something: a turn, a tool call, a
 * question, a sub-agent. While a turn, wait or sub-agent is live that is now
 * (the record's last write). Idle heartbeats are not activity: the desktop
 * keeps a session's process alive long after its last turn, and counting
 * them kept days-old sessions inside every time window. The process start
 * counts only for a session the desktop does not record (a terminal CLI).
 * @param {PublishedSession} pub
 * @param {boolean} hasDesktop
 * @returns {number}
 */
export function publisherActivityAt(pub, hasDesktop) {
  const isLive = pub.endedAt === null && (pub.turn.isRunning || pub.waiting !== null || pub.agents.some(a => a.status === 'running' || a.status === 'pending'))
  if (isLive) return pub.updatedAt
  const agentAt = pub.agents.map(a => Math.max(a.lastActivityAt ?? 0, a.finishedAt ?? 0, a.startedAt ?? 0))
  return Math.max(hasDesktop ? 0 : pub.startedAt, pub.turn.startedAt ?? 0, pub.turn.endedAt ?? 0, pub.tools.at(-1)?.at ?? 0, ...agentAt)
}

/**
 * A prompt typed after every turn edge the live mod has reported: the mod
 * starts (or wakes) only after the prompt, so for those first seconds the
 * desktop's open turn is newer than anything the mod knows.
 * @param {DesktopSession} desktop
 * @param {PublishedSession} pub
 * @returns {boolean}
 */
function isTypedTurnUnseen(desktop, pub) {
  if (desktop.midTurnSource !== 'user-frame' || desktop.turnStartedAt === null) return false
  return Math.max(pub.turn.startedAt ?? 0, pub.turn.endedAt ?? 0) < desktop.turnStartedAt
}

/**
 * A desktop `waiting-input` marker that is the start-up marker of a new or
 * woken session, not a question: the live mod has not yet seen the turn the
 * person just typed (the model has not run, so nothing can have been asked),
 * or the marker is no later than the mod's running turn's start plus slack.
 * A cold start or wake can write it seconds after the typed prompt.
 * @param {DesktopSession} desktop
 * @param {PublishedSession | null} pub
 * @returns {boolean}
 */
function isStartUpMarker(desktop, pub) {
  if (!pub || pub.waiting) return false
  if (desktop.isMidTurn && isTypedTurnUnseen(desktop, pub)) return true
  const markedAt = desktop.waitingMarkedAt ?? null
  return pub.turn.isRunning && pub.turn.startedAt !== null && markedAt !== null && markedAt <= pub.turn.startedAt + TURN_EDGE_SLACK_MS
}

/**
 * Merges what the session's own mod observed with what the desktop recorded.
 * Order: live waits, live turns, desktop waits, desktop mid-turn, last turn's
 * end, the app's post-turn summary, idle. Silence never becomes "completed".
 * @param {LifecycleInput} input
 * @returns {LifecycleResult}
 */
export function lifecycleOf(input) {
  const { desktop, publisher, now, staleMs } = input
  const pub = publisher && publisher.endedAt === null ? publisher : null

  if (pub?.waiting) {
    const isPermission = pub.waiting.kind === 'permission'
    if (now - pub.heartbeatAt > HEARTBEAT_GRACE_MS) {
      return {
        lifecycle: 'disconnected',
        evidence: evidence('mod-events', 'inferred', pub.heartbeatAt, `was waiting for ${isPermission ? 'permission' : 'an answer'}, then stopped reporting`),
        attention: null,
        attentionText: null,
        since: pub.heartbeatAt,
      }
    }
    return {
      lifecycle: isPermission ? 'waiting-permission' : 'waiting-user',
      evidence: evidence('mod-events', 'observed', pub.waiting.since, pub.waiting.tool),
      attention: isPermission ? 'permission' : 'question',
      attentionText: isPermission ? `Approve ${pub.waiting.tool ?? 'a tool call'}` : 'Asked you a question',
      since: pub.waiting.since,
    }
  }

  if (desktop && ((desktop.isWaitingInput && !isStartUpMarker(desktop, pub)) || desktop.isInterruptedAwaitingPerson)) {
    return {
      lifecycle: 'waiting-user',
      evidence: evidence('desktop-metadata', 'observed', desktop.lastActivityAt, 'desktop shows a pending question'),
      attention: 'question',
      attentionText: 'Waiting for your answer',
      since: desktop.lastActivityAt,
    }
  }

  if (pub?.turn.isRunning) {
    const silentFor = now - pub.heartbeatAt
    if (silentFor <= HEARTBEAT_GRACE_MS) {
      return { lifecycle: 'running', evidence: evidence('mod-events', 'observed', pub.heartbeatAt, 'turn running'), attention: null, attentionText: null, since: pub.turn.startedAt }
    }
    return {
      lifecycle: silentFor > staleMs ? 'disconnected' : 'stale',
      evidence: evidence('mod-events', 'inferred', pub.heartbeatAt, 'turn started but the session stopped reporting'),
      attention: null,
      attentionText: null,
      since: pub.heartbeatAt,
    }
  }

  if (publisher && publisher.endedAt !== null && publisher.turn.isRunning) {
    return {
      lifecycle: 'disconnected',
      evidence: evidence('mod-events', 'observed', publisher.endedAt, `session ended mid-turn (${publisher.endReason ?? 'unknown'})`),
      attention: null,
      attentionText: null,
      since: publisher.endedAt,
    }
  }

  if (desktop) {
    if (desktop.isMidTurn && (!pub || isTypedTurnUnseen(desktop, pub))) {
      const idleFor = now - desktop.lastActivityAt
      if (idleFor <= staleMs) {
        return {
          lifecycle: 'running',
          evidence:
            desktop.midTurnSource === 'transcript'
              ? evidence('desktop-metadata', 'inferred', desktop.lastActivityAt, 'transcript written since the turn began')
              : evidence('desktop-metadata', 'observed', desktop.lastActivityAt, 'turn open in desktop metadata'),
          attention: null,
          attentionText: null,
          since: desktop.turnStartedAt,
        }
      }
      return {
        lifecycle: 'stale',
        evidence: evidence('desktop-metadata', 'inferred', desktop.lastActivityAt, 'turn open but no activity recorded since'),
        attention: null,
        attentionText: null,
        since: desktop.lastActivityAt,
      }
    }
  }

  const lastReason = publisher?.turn.lastReason ?? null
  const turnEndedAt = publisher?.turn.endedAt ?? null
  const isLatestTurn = turnEndedAt !== null && (!desktop || turnEndedAt >= desktop.lastTurnEdgeAt - 5_000)
  if (isLatestTurn && (lastReason === 'error' || lastReason === 'refusal')) {
    return {
      lifecycle: 'failed',
      evidence: evidence('mod-events', 'observed', turnEndedAt, `turn ended: ${lastReason}`),
      attention: 'failed',
      attentionText: lastReason === 'refusal' ? 'The model refused the last turn' : 'The last turn ended with an API error',
      since: turnEndedAt,
    }
  }
  if (isLatestTurn && lastReason === 'aborted') {
    return { lifecycle: 'interrupted', evidence: evidence('mod-events', 'observed', turnEndedAt, 'turn interrupted'), attention: null, attentionText: null, since: turnEndedAt }
  }

  if (desktop) {
    const at = desktop.lastActivityAt
    const since = desktop.lastTurnEdgeAt || at
    if (desktop.summary.needsAction) {
      return {
        lifecycle: 'idle',
        evidence: evidence('desktop-summary', 'inferred', at, 'app summary says it needs you'),
        attention: 'needs-you',
        attentionText: desktop.summary.needsAction,
        since,
      }
    }
    switch (desktop.summary.category) {
      case 'blocked':
        return { lifecycle: 'idle', evidence: evidence('desktop-summary', 'inferred', at, 'app summary: blocked'), attention: 'blocked', attentionText: desktop.summary.detail || 'Blocked', since }
      case 'completed':
        return { lifecycle: 'completed', evidence: evidence('desktop-summary', 'inferred', at, 'app summary: completed'), attention: null, attentionText: null, since }
      case 'review_ready':
        return { lifecycle: 'idle', evidence: evidence('desktop-summary', 'inferred', at, 'app summary: ready for review'), attention: 'review', attentionText: desktop.summary.detail || 'Ready for review', since }
      default:
        return { lifecycle: 'idle', evidence: evidence('desktop-metadata', 'observed', at, 'no turn open'), attention: null, attentionText: null, since }
    }
  }

  if (publisher) {
    if (publisher.endedAt !== null) {
      return {
        lifecycle: 'idle',
        evidence: evidence('mod-events', 'observed', publisher.endedAt, `session ended (${publisher.endReason ?? 'exit'})`),
        attention: null,
        attentionText: null,
        since: publisher.endedAt,
      }
    }
    return { lifecycle: 'idle', evidence: evidence('mod-events', 'observed', publisher.updatedAt, 'no turn running'), attention: null, attentionText: null, since: publisher.turn.endedAt ?? publisher.startedAt }
  }

  return { lifecycle: 'unknown', evidence: evidence('none', 'unknown', null), attention: null, attentionText: null, since: null }
}

/** Thresholds for `stuckOf`, tuned on real transcripts (docs/ARCHITECTURE.md, Maybe stuck; `tools/stuck-replay.mjs`). */
export const STUCK = {
  repeatCalls: 3,
  repeatFailed: 2,
  repeatWindowMs: 10 * 60_000,
  errorCalls: 4,
  errorOf: 6,
  errorWindowMs: 10 * 60_000,
}

/** Tool calls that wait on something else (background shells, monitors) and never count towards stuck. */
export const STUCK_WAITS = /^(BashOutput|TaskOutput|KillShell|TaskStop|Monitor|ScheduleWakeup|Sleep)$/

/**
 * Whether a running session looks stuck, from its main agent's tool calls in
 * the current turn (first rule wins): the same call failing over and over, or
 * most recent calls failing. Either needs the latest call to have failed, so
 * the hint clears as soon as a call succeeds. Inferred, never observed; null
 * unless `lifecycle` is running. `runningSince` is the turn's start.
 * @param {readonly ToolRecord[]} tools
 * @param {number} now
 * @param {Lifecycle} lifecycle
 * @param {number | null} runningSince
 * @returns {StuckView | null}
 */
export function stuckOf(tools, now, lifecycle, runningSince) {
  if (lifecycle !== 'running') return null
  const turnStart = runningSince ?? 0
  const main = tools.filter(t => t.agentId === null && t.pending !== true && t.at >= turnStart && t.at <= now && !STUCK_WAITS.test(t.tool))
  const last = main.at(-1)
  if (!last || !last.isError) return null

  if (now - last.at <= STUCK.repeatWindowMs) {
    let first = main.length - 1
    while (first > 0 && main[first - 1]?.tool === last.tool && main[first - 1]?.target === last.target) first -= 1
    const run = main.slice(first)
    const failed = run.filter(t => t.isError).length
    const start = run[0]
    if (run.length >= STUCK.repeatCalls && failed >= STUCK.repeatFailed && start && now - start.at <= STUCK.repeatWindowMs) {
      return { kind: 'repeat', text: `Same call ${run.length} times, ${failed} failed: ${`${last.tool} ${last.target}`.trim()}`, since: start.at }
    }
  }

  const recent = main.slice(-STUCK.errorOf).filter(t => now - t.at <= STUCK.errorWindowMs)
  const failed = recent.filter(t => t.isError)
  if (failed.length >= STUCK.errorCalls) {
    return { kind: 'errors', text: `${failed.length} of the last ${recent.length} calls failed`, since: failed[0]?.at ?? now }
  }
  return null
}

/** @type {readonly Lifecycle[]} */
const WAITS_ON_AGENTS = ['idle', 'completed', 'unknown', 'stale']

/**
 * A session whose own turn has ended while its sub-agents still run is
 * waiting on them, not idle or ready for review: it reads as running, with
 * inferred evidence from its sub-agents. A wait on the person stays as is.
 * @param {LifecycleResult} life
 * @param {readonly { lifecycle: Lifecycle, evidence: Evidence, startedAt: number | null, lastActivityAt: number | null }[]} agents
 * @returns {LifecycleResult & { agentsRunning: number }}
 */
export function withRunningAgents(life, agents) {
  const running = agents.filter(a => a.lifecycle === 'running')
  if (running.length === 0 || !WAITS_ON_AGENTS.includes(life.lifecycle) || (life.attention !== null && life.attention !== 'review')) {
    return { ...life, agentsRunning: running.length }
  }
  const latest = Math.max(...running.map(a => a.lastActivityAt ?? 0)) || null
  const started = running.map(a => a.startedAt).filter(t => t !== null)
  const source = running.some(a => a.evidence.source === 'mod-events') ? 'mod-events' : 'subagent-meta'
  const words = running.length === 1 ? '1 sub-agent running' : `${running.length} sub-agents running`
  return {
    lifecycle: 'running',
    evidence: evidence(source, 'inferred', latest, words),
    attention: null,
    attentionText: null,
    since: started.length ? Math.min(...started) : life.since,
    agentsRunning: running.length,
  }
}

/**
 * @param {string | null} status
 * @param {boolean | null} finished
 * @param {number | null} lastActivityAt
 * @param {number} now
 * @param {number} staleMs
 * @param {Evidence['source']} source
 * @returns {{ lifecycle: Lifecycle, evidence: Evidence }}
 */
export function agentLifecycle(status, finished, lastActivityAt, now, staleMs, source) {
  const confidence = source === 'mod-events' ? 'observed' : 'inferred'
  switch (status) {
    case 'waiting':
      return { lifecycle: 'running', evidence: evidence(source, confidence, lastActivityAt, 'waiting on its own background work') }
    case 'pending':
    case 'running':
      if (lastActivityAt !== null && now - lastActivityAt > staleMs) {
        return { lifecycle: 'stale', evidence: evidence(source, 'inferred', lastActivityAt, `${status} but silent`) }
      }
      return { lifecycle: 'running', evidence: evidence(source, confidence, lastActivityAt, status) }
    case 'idle':
      return { lifecycle: 'idle', evidence: evidence(source, confidence, lastActivityAt, status) }
    case 'completed':
      return { lifecycle: 'completed', evidence: evidence(source, confidence, lastActivityAt, status) }
    case 'failed':
      return { lifecycle: 'failed', evidence: evidence(source, confidence, lastActivityAt, status) }
    case 'killed':
      return { lifecycle: 'interrupted', evidence: evidence(source, confidence, lastActivityAt, status) }
    default:
      break
  }
  if (finished === true) return { lifecycle: 'completed', evidence: evidence('subagent-meta', 'observed', lastActivityAt, 'finished') }
  if (finished === false) {
    if (lastActivityAt !== null && now - lastActivityAt <= staleMs) {
      return { lifecycle: 'running', evidence: evidence('subagent-meta', 'inferred', lastActivityAt, 'not finished, transcript still growing') }
    }
    return { lifecycle: 'stale', evidence: evidence('subagent-meta', 'inferred', lastActivityAt, 'not finished, transcript silent') }
  }
  return { lifecycle: 'unknown', evidence: evidence('none', 'unknown', lastActivityAt) }
}
