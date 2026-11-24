import { randomBytes, timingSafeEqual } from 'node:crypto'

export const COOKIE_NAME = 'orbit'
export const LAUNCH_CODE_MS = 60_000

const CONTROL_ROUTES = new Set(['GET /api/ping', 'POST /api/window', 'POST /api/shutdown', 'GET /api/arm'])
const CONTROL_PREFIXES = ['/api/hook/', '/api/mod/']

/**
 * The routes the control token reaches (E-03): the launcher's ping, window
 * and shutdown, the arm state for indicators, and the hook's and mods' own
 * routes. Everything else needs the page secret, which never touches disk.
 * @param {string | undefined} method
 * @param {string} route
 * @returns {boolean}
 */
export function isControlRoute(method, route) {
  return CONTROL_ROUTES.has(`${method} ${route}`) || CONTROL_PREFIXES.some(prefix => route.startsWith(prefix))
}

/** The Content-Security-Policy of the HTML pages: scripts, data and frames from Orbit only; no base or form targets. */
export const PAGE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const QUERY_TOKEN_ROUTES = new Set(['/inbox', '/api/events'])

/**
 * The page secret given as `?t=`: read only by a dry-run server (its tests
 * and tools open pages that way), on `/inbox` and the event stream.
 * A real window signs in with its one-time launch link and then the cookie,
 * so no token ever rides in a URL there.
 * @param {URL} url
 * @param {string} route
 * @param {boolean} isDryRun
 * @returns {string | null}
 */
export function queryToken(url, route, isDryRun) {
  return isDryRun && QUERY_TOKEN_ROUTES.has(route) ? url.searchParams.get('t') : null
}

/**
 * @param {string | undefined} header
 * @returns {string | null}
 */
export function cookieToken(header) {
  if (typeof header !== 'string') return null
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === COOKIE_NAME) return part.slice(at + 1).trim() || null
  }
  return null
}

/**
 * @param {string} expected
 * @returns {(given: unknown) => boolean}
 */
function matcher(expected) {
  const bytes = Buffer.from(expected)
  return given => {
    if (typeof given !== 'string') return false
    const other = Buffer.from(given)
    return other.length === bytes.length && timingSafeEqual(other, bytes)
  }
}

/**
 * One server process's secrets (E-03, E-16, E-50): a page token handed only
 * to the window (as an HttpOnly cookie, in exchange for a one-time launch
 * code), and a control token written to `companion.json` for the launcher,
 * the hook and the mods.
 */
export function createSecrets() {
  let pageToken = randomBytes(24).toString('hex')
  const controlToken = randomBytes(24).toString('hex')
  let isPage = matcher(pageToken)
  const isControl = matcher(controlToken)
  /** @type {Map<string, number>} */
  const codes = new Map()
  /** @type {Set<string>} */
  const used = new Set()
  return {
    get pageToken() {
      return pageToken
    },
    controlToken,
    /**
     * A new page secret: every cookie handed out before stops working. Used
     * when a launch code was redeemed by something other than the window
     * (launch codes are visible on Edge's command line).
     */
    rotatePage() {
      pageToken = randomBytes(24).toString('hex')
      isPage = matcher(pageToken)
    },
    /** @param {unknown} code */
    wasUsed(code) {
      return typeof code === 'string' && used.has(code)
    },
    /** @param {unknown} given @returns {'page' | 'control' | null} */
    scopeOf(given) {
      if (isPage(given)) return 'page'
      if (isControl(given)) return 'control'
      return null
    },
    /** @param {number} now */
    issueLaunchCode(now) {
      for (const [code, until] of codes) if (until < now) codes.delete(code)
      const code = randomBytes(16).toString('hex')
      codes.set(code, now + LAUNCH_CODE_MS)
      return code
    },
    /** @param {unknown} code @param {number} now */
    redeemLaunchCode(code, now) {
      if (typeof code !== 'string') return false
      const until = codes.get(code)
      if (until === undefined) return false
      codes.delete(code)
      used.add(code)
      if (used.size > 100) used.delete(used.values().next().value)
      return until >= now
    },
  }
}
