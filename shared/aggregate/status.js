// @ts-check

import { ACTIVE_LIFECYCLES } from '../constants.js'
import { failureText } from '../failure.js'

/** @typedef {import('../../types').SessionView} SessionView */
/** @typedef {'needs-you' | 'working' | 'review' | 'idle' | 'failed'} Bucket */
/** @typedef {{ bucket: Bucket, reason: string, since: number | null, isObserved: boolean }} Status */
/** @typedef {{ kind: 'permission' | 'question', toolName: string, createdAt: number }} PendingApproval */
/** @typedef {{ category: string, at: number, source: string, isCurrent: boolean }} Failure */

const REASON_MAX = 120
const NEEDS_YOU = new Set(['question', 'permission', 'needs-you', 'blocked'])
const IDLE_REASONS = /** @type {Record<string, string>} */ ({
  interrupted: 'Interrupted',
  disconnected: 'Stopped reporting',
  completed: 'Finished',
  idle: 'Idle',
  unknown: 'No recent activity',
})

/**
 * @param {string | null | undefined} text
 * @param {string} fallback
 */
function line(text, fallback) {
  const folded = String(text ?? '').replace(/\s+/g, ' ').trim()
  const plain = folded || fallback
  return plain.length > REASON_MAX ? `${plain.slice(0, REASON_MAX - 1)}…` : plain
}

/**
 * @param {Bucket} bucket
 * @param {string} reason
 * @param {number | null | undefined} since
 * @param {boolean} isObserved
 * @returns {Status}
 */
function status(bucket, reason, since, isObserved) {
  return { bucket, reason: line(reason, bucket), since: typeof since === 'number' ? since : null, isObserved }
}

/**
 * A session's one status (docs/CONTRACT.md "status"): five buckets, first
 * rule wins: a pending Orbit approval or question, attention on the person,
 * a failure, work in progress, a finished turn not looked at, then idle.
 * `extra` carries what the snapshot schema 1 lacks: pending approvals from
 * `approvals/`, the desktop's last-focused time and its current failure mark.
 * @param {SessionView} s
 * @param {{ approvals?: readonly PendingApproval[], lastFocusedAt?: number | null, failure?: Failure | null, prProblem?: { reason: string, since: number } | null }} extra `prProblem`: "PR problems need you" (`prProblems`), applied only to a quiet session
 * @param {number} now
 * @returns {Status}
 */
export function statusOf(s, extra, now) {
  const isObserved = s.lifecycleEvidence?.confidence === 'observed'
  const waiting = [...(extra.approvals ?? [])].sort((a, b) => a.createdAt - b.createdAt)
  const pending = waiting[0]
  if (pending) {
    const reason = waiting.length > 1 ? `${waiting.length} requests waiting` : pending.kind === 'question' ? 'Asked you a question' : `Approve ${pending.toolName || 'a tool call'}?`
    return status('needs-you', reason, pending.createdAt, true)
  }
  if (s.attention && NEEDS_YOU.has(s.attention)) {
    const attentionObserved = s.attentionEvidence ? s.attentionEvidence.confidence === 'observed' : isObserved
    return status('needs-you', s.attentionText ?? 'Needs you', s.attentionSince ?? s.stateSince, attentionObserved)
  }
  if (s.lifecycle === 'failed') return status('failed', s.attentionText ?? 'The last turn failed', s.stateSince, isObserved)
  if (extra.failure?.isCurrent) return status('failed', failureText(extra.failure.category), extra.failure.at, true)
  if (s.lifecycle === 'running') return status('working', s.activity ?? 'Working', s.stateSince, isObserved)
  if (s.lifecycle === 'stale') {
    const minutes = Math.max(1, Math.round((now - (s.stateSince ?? s.lastActivityAt)) / 60_000))
    return status('working', `No activity for ${minutes}m · may be stuck`, s.stateSince, false)
  }
  if (extra.prProblem && !ACTIVE_LIFECYCLES.includes(s.lifecycle)) return status('needs-you', extra.prProblem.reason, extra.prProblem.since, true)
  const finishedAt = s.finishedAt
  const lastFocusedAt = extra.lastFocusedAt ?? null
  if (s.attention === 'review' || (lastFocusedAt !== null && finishedAt !== null && finishedAt > lastFocusedAt)) {
    return status('review', 'Finished, not opened since', finishedAt ?? s.stateSince, isObserved)
  }
  return status('idle', IDLE_REASONS[s.lifecycle] ?? 'Idle', s.stateSince, isObserved)
}

const SET_ASIDE = new Set(['needs-you', 'review', 'failed'])

/**
 * The person's own marks folded into a status (C6). Done: the session is
 * out of Needs you, Review and Failed until it changes after the mark (a
 * new turn, a finished turn, a new need), read from its state times, not
 * from heartbeats. Snooze: the same until its time, except that a need
 * that began after the snooze comes through; a working session keeps its
 * bucket and only carries `snoozedUntil`.
 * @param {Status} status
 * @param {{ key: string, stateSince?: number | null, finishedAt?: number | null }} session
 * @param {{ done?: Readonly<Record<string, number>>, snoozed?: Readonly<Record<string, { until: number, at: number }>> }} marks
 * @param {number} now
 * @returns {Status & { isDone: boolean, snoozedUntil: number | null }}
 */
export function withPersonMarks(status, session, marks, now) {
  const needSince = status.bucket === 'needs-you' ? status.since ?? 0 : 0
  const changedAt = Math.max(session.stateSince ?? 0, session.finishedAt ?? 0, needSince)
  const doneAt = marks.done?.[session.key]
  if (typeof doneAt === 'number' && changedAt <= doneAt) return { bucket: 'idle', reason: 'Done', since: doneAt, isObserved: false, isDone: true, snoozedUntil: null }
  const snooze = marks.snoozed?.[session.key]
  if (snooze && now < snooze.until && !(status.bucket === 'needs-you' && needSince > snooze.at)) {
    if (SET_ASIDE.has(status.bucket)) return { bucket: 'idle', reason: 'Snoozed', since: snooze.at, isObserved: false, isDone: false, snoozedUntil: snooze.until }
    return { ...status, isDone: false, snoozedUntil: snooze.until }
  }
  return { ...status, isDone: false, snoozedUntil: null }
}
