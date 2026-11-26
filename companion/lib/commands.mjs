import { COMMANDS_MAX, isCommandAllowed } from '../../shared/inbox.js'

const FRESH_MS = 10 * 60_000
const SESSIONS_MAX = 200
const SOURCES = new Set(['builtin', 'plugin', 'user', 'mcp'])
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * @typedef {{ name: string, description: string, source: string, plugin?: string }} PublishedCommand
 */

/**
 * The slash commands each session's mod published (names, short
 * descriptions, sources and, for a plugin's, the plugin's name), in the
 * server's memory only: what the page's `/` menu lists and what a reply may
 * run. A list older than ten minutes is treated as gone, so a closed
 * session's commands stop being offered.
 * @param {{ now?: () => number }} [io]
 */
export function createCommandStore({ now = Date.now } = {}) {
  /** @type {Map<string, { at: number, list: PublishedCommand[] }>} */
  const bySession = new Map()
  return {
    /** Keeps `cli`'s list from a mod's raw body; false when it is not a list. */
    set(cli, raw) {
      const commands = raw && typeof raw === 'object' && Array.isArray(raw.commands) ? raw.commands : null
      if (!commands) return false
      /** @type {PublishedCommand[]} */
      const list = []
      const names = new Set()
      for (const c of commands.slice(0, COMMANDS_MAX)) {
        if (!c || typeof c !== 'object' || !isCommandAllowed(c.name) || names.has(c.name)) continue
        names.add(c.name)
        const source = SOURCES.has(c.source) ? c.source : 'builtin'
        list.push({
          name: c.name,
          description: typeof c.description === 'string' ? c.description.replace(/\s+/g, ' ').trim().slice(0, 120) : '',
          source,
          ...(source === 'plugin' && typeof c.plugin === 'string' && PLUGIN_NAME.test(c.plugin) ? { plugin: c.plugin } : {}),
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
    /**
     * Every command any session published lately, once per name (the most
     * recent publisher's description, source and plugin), with how many of
     * those sessions list it; sorted by name.
     * @returns {(PublishedCommand & { sessions: number })[]}
     */
    catalog() {
      /** @type {Map<string, PublishedCommand & { sessions: number }>} */
      const byName = new Map()
      const at = now()
      for (const entry of [...bySession.values()].reverse()) {
        if (at - entry.at > FRESH_MS) continue
        for (const c of entry.list) {
          const seen = byName.get(c.name)
          if (seen) seen.sessions += 1
          else byName.set(c.name, { ...c, sessions: 1 })
        }
      }
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    },
  }
}
