import { randomUUID } from 'node:crypto'

export const STOP_PROTOCOL = 1
export const STOP_TTL_MS = 15_000
const STOPS_MAX = 100
const OUTCOMES = new Set(['stopped', 'idle', 'failed'])

/**
 * Stop requests held in the server's memory: the page asks to stop one
 * session's running turn, that session's mod fetches it with its replies,
 * claims it, aborts its own turn (or, with `agentId`, stops that sub-agent)
 * and acknowledges the outcome. One open request per session or sub-agent; a
 * request nobody claims in 15 s expires.
 * @param {{ now?: () => number }} io
 */
export function createStopQueue({ now = Date.now } = {}) {
  /** @type {Map<string, { cli: string, agentId: string | null, createdAt: number, claimed: boolean, outcome: string | null, isExpiryLogged?: boolean }>} */
  const entries = new Map()
  const isOpen = (e, at) => !e.outcome && at - e.createdAt <= STOP_TTL_MS
  return {
    entries,
    request(cli, agentId = null) {
      const at = now()
      for (const [id, e] of entries) if (e.cli === cli && e.agentId === agentId && !e.claimed && isOpen(e, at)) return { id, createdAt: e.createdAt }
      const id = randomUUID()
      entries.set(id, { cli, agentId, createdAt: at, claimed: false, outcome: null })
      while (entries.size > STOPS_MAX) entries.delete(entries.keys().next().value)
      return { id, createdAt: at }
    },
    pendingFor(cli) {
      const at = now()
      const stops = []
      for (const [id, e] of entries) if (e.cli === cli && !e.claimed && isOpen(e, at)) stops.push({ id, createdAt: e.createdAt, ...(e.agentId ? { agentId: e.agentId } : {}) })
      return stops
    },
    claim(id, cli) {
      const e = entries.get(id)
      if (!e || e.cli !== cli) return { ok: false, reason: 'unknown' }
      if (e.claimed) return { ok: false, reason: 'replay' }
      if (!isOpen(e, now())) return { ok: false, reason: 'expired' }
      e.claimed = true
      return { ok: true }
    },
    ack(id, cli, outcome) {
      const e = entries.get(id)
      if (!e || e.cli !== cli || !e.claimed || e.outcome || !OUTCOMES.has(outcome)) return false
      e.outcome = outcome
      return true
    },
    /** The page's answer for one stop; a final one is forgotten once read. */
    result(id) {
      const e = entries.get(id)
      if (!e) return null
      if (e.outcome) {
        entries.delete(id)
        return { status: e.outcome }
      }
      if (!e.claimed && now() - e.createdAt > STOP_TTL_MS) {
        entries.delete(id)
        return { status: 'expired' }
      }
      return { status: 'pending' }
    },
    expired(at) {
      const out = []
      for (const [id, e] of entries) {
        if (e.isExpiryLogged || e.claimed || e.outcome || at - e.createdAt <= STOP_TTL_MS) continue
        e.isExpiryLogged = true
        out.push(id)
      }
      return out
    },
  }
}
