// @ts-check

import { MAX_LINK_CHARS, MAX_PROMPT_CHARS } from './constants.js'

/** @typedef {import('../types').Snapshot} Snapshot */

/**
 * The folder a new session should open in, as an absolute local Windows path
 * (`C:\x`, slashes either way, optional quotes), or null when the text is not
 * one. Network (UNC) paths are refused: Claude cannot open them as a project
 * and touching one can hand an NTLM hash to whoever serves it.
 * @param {string} input
 * @returns {string | null}
 */
export function normalizeFolder(input) {
  let path = String(input ?? '')
    .trim()
    .replace(/^"([^"]*)"$/, '$1')
    .trim()
    .replace(/\//g, '\\')
  if (path === '' || path.length > 1000 || /[\u0000-\u001f<>|?*"]/.test(path)) return null
  if (!/^[A-Za-z]:\\/.test(path)) return null
  const rest = path.slice(2)
  if (rest.includes(':')) return null
  if (rest.split('\\').some(part => part === '.' || part === '..')) return null
  path = path.slice(0, 2) + rest.replace(/\\{2,}/g, '\\')
  if (path.length > 3) path = path.replace(/\\+$/, '')
  return path
}

/**
 * The documented link that opens Claude desktop's new Code session page with
 * the folder and prompt filled in (support.claude.com, "Open Claude Desktop
 * with a link"). The app asks the person to confirm the folder and never
 * sends the prompt by itself; it does not open an existing session.
 * @param {string} folder an absolute folder from `normalizeFolder`
 * @param {string} prompt
 * @returns {string}
 */
export function newSessionLink(folder, prompt) {
  const params = [`folder=${encodeURIComponent(folder)}`]
  const text = prompt.trim()
  if (text !== '') params.push(`q=${encodeURIComponent(text)}`)
  return `claude://code/new?${params.join('&')}`
}

/**
 * Checks what was typed for a new session; the caller still confirms the
 * folder exists before launching `link`.
 * @param {unknown} folderText
 * @param {unknown} promptText
 * @returns {{ ok: true, folder: string, link: string } | { ok: false, error: string }}
 */
export function checkNewSession(folderText, promptText) {
  const folder = normalizeFolder(typeof folderText === 'string' ? folderText : '')
  if (!folder) return { ok: false, error: 'Enter an absolute local folder, like C:\\repos\\app.' }
  const prompt = typeof promptText === 'string' ? promptText : ''
  if (prompt.trim().length > MAX_PROMPT_CHARS) return { ok: false, error: `Keep the first prompt under ${MAX_PROMPT_CHARS} characters.` }
  const link = newSessionLink(folder, prompt)
  if (link.length > MAX_LINK_CHARS) return { ok: false, error: 'That prompt is too long to pass in a link; shorten it.' }
  return { ok: true, folder, link }
}

/**
 * The link that switches the desktop app to an existing session
 * (undocumented; verified by hand).
 * @param {string} localId
 * @returns {string}
 */
export function openSessionLink(localId) {
  return `claude://claude.ai/epitaxy/${localId}`
}

/**
 * The `claude://` link the server could not launch and handed back for the
 * window to open, or null for anything but an Open or New session link.
 * @param {unknown} detail the server's error body
 * @returns {string | null}
 */
export function handOffLink(detail) {
  const link = /** @type {{ handOff?: unknown } | null} */ (detail)?.handOff
  if (typeof link !== 'string' || link.length > MAX_LINK_CHARS) return null
  if (/^claude:\/\/claude\.ai\/epitaxy\/local_[0-9a-f-]+$/i.test(link)) return link
  return /^claude:\/\/code\/new\?folder=[^#\s]+$/.test(link) ? link : null
}

const MAX_BROWSER_URL_CHARS = 4096

/**
 * The web address a chat link may hand to the default browser, normalised
 * (spaces, quotes and other unsafe characters percent-encoded), or null for
 * anything but an http or https URL.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function browserUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_BROWSER_URL_CHARS) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const href = url.href
  return href.length > MAX_BROWSER_URL_CHARS || /[\s"<>^`|]/.test(href) ? null : href
}

/**
 * @param {string} id
 * @returns {boolean}
 */
export function isDesktopSessionId(id) {
  return /^local_[0-9a-f-]+$/i.test(id)
}

/**
 * Folders a new session is likely to start in: each checkout sessions ran in,
 * then any project root not yet listed, most recently active first.
 * @param {import('../types').SnapshotV2} snapshot
 * @param {number} [limit]
 * @returns {{ path: string, label: string }[]}
 */
export function recentFolders(snapshot, limit = 12) {
  const lastBySession = new Map(snapshot.sessions.map(s => [s.key, s.lastActivityAt]))
  const nameById = new Map(snapshot.projects.map(p => [p.id, p.name]))
  /** @type {Map<string, { path: string, label: string, at: number }>} */
  const byKey = new Map()
  /**
   * @param {string} raw
   * @param {string} label
   * @param {number} at
   */
  const add = (raw, label, at) => {
    const path = normalizeFolder(raw)
    if (!path) return
    const key = path.toLowerCase()
    const existing = byKey.get(key)
    if (!existing || existing.at < at) byKey.set(key, { path, label, at })
  }
  for (const w of snapshot.worktrees) {
    const at = Math.max(0, ...w.sessionKeys.map(k => lastBySession.get(k) ?? 0))
    const name = nameById.get(w.projectId) ?? 'folder'
    add(w.path, w.isMain ? name : `${name} (${w.branch ?? 'worktree'})`, at)
  }
  for (const p of snapshot.projects) if (!byKey.has((normalizeFolder(p.root) ?? '').toLowerCase())) add(p.root, p.name, p.lastActivityAt)
  return [...byKey.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map(({ path, label }) => ({ path, label }))
}
