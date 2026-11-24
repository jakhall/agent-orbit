import { COMMANDS_MAX, isCommandAllowed } from '../../shared/inbox.js'

const FRESH_MS = 10 * 60_000
const SESSIONS_MAX = 200
const SOURCES = new Set(['builtin', 'plugin', 'user', 'mcp'])

/**
 * The slash commands each session's mod published (names, short
 * descriptions and sources), in the server's memory only: what the page's
 * `/` menu lists and what a reply may run. A list older than ten minutes is
 * treated as gone, so a closed session's commands stop being offered.
 * @param {{ now?: () => number }} [io]
 */
export function createCommandStore({ now = Date.now } = {}) {
  /** @type {Map<string, { at: number, list: { name: string, description: string, source: string }[] }>} */
  const bySession = new Map()
  return {
    /** Keeps `cli`'s list from a mod's raw body; false when it is not a list. */
    set(cli, raw) {
      const commands = raw && typeof raw === 'object' && Array.isArray(raw.commands) ? raw.commands : null
      if (!commands) return false
      const list = []
      const names = new Set()
      for (const c of commands.slice(0, COMMANDS_MAX)) {
        if (!c || typeof c !== 'object' || !isCommandAllowed(c.name) || names.has(c.name)) continue
        names.add(c.name)
        list.push({
          name: c.name,
          description: typeof c.description === 'string' ? c.description.replace(/\s+/g, ' ').trim().slice(0, 120) : '',
          source: SOURCES.has(c.source) ? c.source : 'builtin',
        })
      }
      bySession.delete(cli)
      bySession.set(cli, { at: now(), list })
      while (bySession.size > SESSIONS_MAX) bySession.delete(bySession.keys().next().value)
      return true
    },
    /** `cli`'s fresh list, or null when it published none lately. */
    listFor(cli) {
      const entry = bySession.get(cli)
      return entry && now() - entry.at <= FRESH_MS ? entry.list : null
    },
    /** The names a reply to `cli` may run, or null. */
    namesFor(cli) {
      const list = this.listFor(cli)
      return list ? new Set(list.map(c => c.name)) : null
    },
  }
}
