export const NOTICE_TTL_MS = 2 * 60_000
export const NOTICE_MODES = ['all', 'needs-you', 'off']
export const WINDOW_FIRST_MS = 5_000
const PER_SESSION_MS = 60_000
const STALE_SINCE_MS = 5 * 60_000
const SEEN_MAX = 2_000
const KINDS = { 'needs-you': 'Needs you', failed: 'Failed', review: 'Ready for review' }

const clip = (/** @type {unknown} */ text, /** @type {number} */ max) => (typeof text === 'string' ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : '')

/**
 * @typedef {{ id: string, sessionKey: string, kind: string, label: string, sessionTitle: string, title: string, body: string, at: number, isQuiet: boolean, claimedBy: string | null }} Notice
 */

/**
 * Notices the server raises from its own snapshot (G-20, G-21): a session
 * entering Needs you, Failed, or (mode `all`) Review, once per need (session,
 * bucket and when it began). Nothing on the first look after a start, for a
 * need that began more than 5 minutes ago, or while muted. At most one per
 * session a minute. While a window is attentive (the person is looking) the
 * notice is quiet: only an Orbit window shows it, as an in-window banner.
 * An open Orbit window claims notices first (it raises the Windows
 * notification); a session's mod may claim one only when no window is open,
 * or after `WINDOW_FIRST_MS` unclaimed.
 * @param {{ now?: () => number }} io
 */
export function createNotices({ now = Date.now } = {}) {
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {Map<string, number>} */
  const lastBySession = new Map()
  /** @type {Notice[]} */
  const queue = []
  let isBaseline = true
  let sequence = 0
  const counts = { raised: 0, claimed: 0, quiet: 0 }
  const view = (/** @type {Notice} */ { claimedBy: _claimed, ...n }) => n

  return {
    /**
     * Returns the notices raised by this look, for pushing to open windows.
     * @param {{ sessions: any[] } | null} snapshot
     * @param {{ mode: string, isAttentive: boolean }} options
     */
    observe(snapshot, { mode, isAttentive }) {
      /** @type {ReturnType<typeof view>[]} */
      const raised = []
      if (!snapshot) return raised
      const at = now()
      for (const session of snapshot.sessions) {
        const status = session.status
        if (!status || !KINDS[status.bucket]) continue
        const needKey = `${session.key}|${status.bucket}|${status.since ?? 0}`
        if (seen.has(needKey)) continue
        seen.add(needKey)
        if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value)
        const isWanted = mode === 'all' || (mode === 'needs-you' && status.bucket !== 'review')
        if (isBaseline || !isWanted || at - (status.since ?? at) > STALE_SINCE_MS) continue
        if (at - (lastBySession.get(session.key) ?? 0) < PER_SESSION_MS) continue
        lastBySession.set(session.key, at)
        sequence += 1
        const label = KINDS[status.bucket]
        const sessionTitle = clip(session.title, 60)
        /** @type {Notice} */
        const notice = { id: `n${at.toString(36)}${sequence}`, sessionKey: session.key, kind: status.bucket, label, sessionTitle, title: `${label} · ${sessionTitle}`, body: clip(status.reason, 120), at, isQuiet: isAttentive, claimedBy: null }
        queue.push(notice)
        raised.push(view(notice))
        counts.raised += 1
        if (isAttentive) counts.quiet += 1
      }
      isBaseline = false
      while (queue.length > 50 || (queue[0] && at - queue[0].at > NOTICE_TTL_MS)) queue.shift()
      return raised
    },
    /**
     * Unclaimed, fresh notices a session's mod may take: never quiet ones,
     * and while a window is open only those it left for `WINDOW_FIRST_MS`.
     * @param {{ hasWindow?: boolean }} [options]
     */
    pendingFor({ hasWindow = false } = {}) {
      const at = now()
      return queue.filter(n => n.claimedBy === null && !n.isQuiet && at - n.at <= NOTICE_TTL_MS && (!hasWindow || at - n.at >= WINDOW_FIRST_MS)).map(view)
    },
    /**
     * First claim wins; `by` is a session's cli id or `window:<id>`.
     * @param {string} id
     * @param {unknown} by
     */
    claim(id, by) {
      const notice = queue.find(n => n.id === id)
      if (!notice || notice.claimedBy !== null || typeof by !== 'string' || !by) return { ok: false }
      if (notice.isQuiet && !by.startsWith('window:')) return { ok: false }
      notice.claimedBy = by
      counts.claimed += 1
      return { ok: true }
    },
    stats: () => ({ ...counts }),
  }
}
