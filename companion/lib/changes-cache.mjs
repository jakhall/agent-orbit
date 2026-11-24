export const CHANGES_TTL_MS = 45_000
export const CHANGES_TIMEOUT_TTL_MS = 2 * 60_000

/**
 * Whether a cached Changes answer for a session may be served again: for
 * 45 s while the session's folder is the same and it has not been active
 * since, unless the page asked for a fresh one; a timed-out repository is
 * not asked again for 2 minutes either way.
 * @param {{ at: number, cwd: string, state?: string } | null | undefined} cached
 * @param {{ cwd: string, lastActivityAt?: unknown }} session
 * @param {number} now
 * @param {boolean} wantsFresh
 * @returns {boolean}
 */
export function canReuseChanges(cached, session, now, wantsFresh) {
  if (!cached || cached.cwd !== session.cwd) return false
  if (cached.state === 'timeout') return now - cached.at < CHANGES_TIMEOUT_TTL_MS
  if (wantsFresh) return false
  if (typeof session.lastActivityAt === 'number' && session.lastActivityAt > cached.at) return false
  return now - cached.at < CHANGES_TTL_MS
}
