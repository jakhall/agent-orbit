import type { Prefs, Snapshot } from '../../types'
import { withPersonMarks } from '../../shared/aggregate/status.js'

/**
 * The snapshot with this person's Done and Snooze marks folded in, as the
 * server folds them, so a mark shows before the server's next snapshot
 * arrives; the same snapshot when no session's status changes.
 */
export function withLocalMarks(snapshot: Snapshot, marks: Pick<Prefs, 'done' | 'snoozed'>, now: number): Snapshot {
  const done = marks.done ?? {}
  const snoozed = marks.snoozed ?? {}
  let isChanged = false
  const sessions = snapshot.sessions.map(s => {
    if (!s.status || (!(s.key in done) && !(s.key in snoozed))) return s
    const status = withPersonMarks(s.status, s, { done, snoozed }, now)
    if (status.bucket === s.status.bucket && status.reason === s.status.reason && status.snoozedUntil === (s.status.snoozedUntil ?? null)) return s
    isChanged = true
    return { ...s, status }
  })
  return isChanged ? { ...snapshot, sessions } : snapshot
}
