import { isOlderVersion } from '../../shared/version.js'

export const IDLE_EXIT_MS = 30 * 60_000
export const WINDOW_GRACE_MS = 30_000

/**
 * What `--launch` does about a running server: start one when none runs,
 * replace only an older one, and reuse a same-version or newer one (a
 * newer server is never replaced). A window opens when asked for, and when
 * a replaced server had one open, so a replace never leaves a page dead.
 * @param {{ version?: string, clients?: number } | null} running the live server's `companion.json`, or null
 * @param {string} onDisk the launcher's own version
 * @param {boolean} wantsWindow
 * @returns {{ action: 'start' | 'replace' | 'reuse', openWindow: boolean }}
 */
export function launchDecision(running, onDisk, wantsWindow) {
  if (!running) return { action: 'start', openWindow: wantsWindow }
  if (isOlderVersion(running.version, onDisk)) return { action: 'replace', openWindow: wantsWindow || (running.clients ?? 0) > 0 }
  return { action: 'reuse', openWindow: wantsWindow }
}

/**
 * Whether a server with nobody to serve may exit: no window connected,
 * and none for 30 minutes, and no session record changed for 30 minutes,
 * counted from its own start when it has seen neither.
 * @param {{ now: number, clients: number, lastClientAt: number, lastRecordChangeAt: number, startedAt: number }} s
 * @returns {boolean}
 */
export function shouldIdleExit(s) {
  if (s.clients > 0) return false
  const lastSign = Math.max(s.lastClientAt, s.lastRecordChangeAt, s.startedAt)
  return s.now - lastSign > IDLE_EXIT_MS
}

const ACTING_ROUTES = new Set(['/api/reply', '/api/launch', '/api/open', '/api/open-url', '/api/new', '/api/clear', '/api/arm', '/api/stop'])
const ACTING_PATTERNS = [/^\/api\/reply\/[0-9a-f-]{36}\/(withdraw|wait)$/i, /^\/api\/approvals\/[^/]+$/]

/**
 * The routes that act on sessions or the person's approvals. While no
 * window is present (`isWindowAway`) they answer 409 `no-window`: a guard
 * against acting with nobody looking, not an access control (the token is
 * the boundary; a token holder can open a stream). docs/CONTRACT.md.
 * @param {string | undefined} method
 * @param {string} route
 * @returns {boolean}
 */
export function isActingRoute(method, route) {
  if (method !== 'POST') return false
  return ACTING_ROUTES.has(route) || ACTING_PATTERNS.some(p => p.test(route))
}

/**
 * No window is present: no event stream is open, and none closed within
 * WINDOW_GRACE_MS (a page reconnecting after sleep or a blip keeps acting).
 * @param {{ clients: number, lastClientAt: number, now: number }} s
 * @returns {boolean}
 */
export function isWindowAway(s) {
  if (s.clients > 0) return false
  return s.lastClientAt === 0 || s.now - s.lastClientAt > WINDOW_GRACE_MS
}

const PR_ATTENTIVE_MS = 60_000

/**
 * Whether the server checks linked PRs with `gh` now: for a window used in
 * the last minute that shows PRs (or asked for them), as E-114 allows, or,
 * with "PR problems need you" on, with no window at all (the opt-in).
 * @param {{ windows: number, attentiveAgoMs: number, isShown: boolean, isNeedOn: boolean }} s
 * @returns {boolean}
 */
export function shouldCheckPrs(s) {
  if (s.isNeedOn) return true
  return s.windows > 0 && s.attentiveAgoMs <= PR_ATTENTIVE_MS && s.isShown
}
