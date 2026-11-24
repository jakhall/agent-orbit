import { randomUUID } from 'node:crypto'

import { HOLD_TTL_MS, knownReason, REPLY_TTL_MS, withdrawVerdict } from '../../shared/inbox.js'

export const REPLY_PROTOCOL = 2
const REPLIES_MAX = 200
const ACK_STATUSES = new Set(['sent', 'queued', 'refused', 'failed'])
const ttlOf = e => (e.held ? HOLD_TTL_MS : REPLY_TTL_MS)

/**
 * Replies and first prompts held in the server's memory (A5, E-02): a mod
 * fetches its own (`pendingFor`), claims one before submitting it, and
 * acknowledges it; nothing goes through files. A mod whose turn is running
 * holds a reply instead (`hold`): it stays unclaimed, so the page can still
 * withdraw it or mark it to wait, until the mod steers it into the turn or
 * sends it once the turn ends. A slash command (`command`) always waits for
 * the turn's end and cannot be switched to steer. A reply with `agentId` is
 * for one of the session's sub-agents: the mod sends it straight to that
 * sub-agent, so it is never held and never waits. Replies and first prompts
 * are handed out only while `replies` is armed.
 * @param {{ now?: () => number, isArmed: () => boolean }} io
 */
export function createReplyQueue({ now = Date.now, isArmed }) {
  /** @type {Map<string, { cli: string, text: string, createdAt: number, firstPrompt: boolean, command: boolean, agentId: string | null, claimed: boolean, withdrawn: boolean, held: boolean, wait: boolean, ack: { status: string, reason: string | null, at: number | null } | null, isExpiryLogged?: boolean }>} */
  const entries = new Map()
  return {
    entries,
    /** @param {{ cli: string, text: string, firstPrompt?: boolean, command?: boolean, agentId?: string | null }} reply */
    queue({ cli, text, firstPrompt = false, command = false, agentId = null }) {
      const id = randomUUID()
      const createdAt = now()
      entries.set(id, { cli, text, createdAt, firstPrompt, command, agentId, claimed: false, withdrawn: false, held: false, wait: command, ack: null })
      while (entries.size > REPLIES_MAX) entries.delete(entries.keys().next().value)
      return { id, createdAt }
    },
    /** What one session's mod may take now, in the request shape `judgeReply` reads. */
    pendingFor(cli) {
      const armed = isArmed()
      const at = now()
      const replies = []
      for (const [id, e] of entries) {
        if (e.cli !== cli || e.claimed || e.withdrawn || e.ack || at - e.createdAt > ttlOf(e)) continue
        if (!armed) continue
        replies.push({ schema: 1, id, to: cli, text: e.text, createdAt: e.createdAt, ...(e.firstPrompt ? { firstPrompt: true } : {}), ...(e.agentId ? { agentId: e.agentId } : {}), ...(e.held ? { held: true } : {}), ...(e.wait ? { wait: true } : {}) })
      }
      return { armed, replies }
    },
    claim(id, cli) {
      const e = entries.get(id)
      if (!e || e.cli !== cli) return { ok: false, reason: 'unknown' }
      if (e.withdrawn) return { ok: false, reason: 'withdrawn' }
      if (e.claimed) return { ok: false, reason: 'replay' }
      e.claimed = true
      return { ok: true }
    },
    /** The mod keeps an unclaimed reply for its running turn: still withdrawable, deliverable for `HOLD_TTL_MS`. */
    hold(id, cli) {
      const e = entries.get(id)
      if (!e || e.cli !== cli) return { ok: false, reason: 'unknown' }
      if (e.withdrawn) return { ok: false, reason: 'withdrawn' }
      if (e.claimed || e.ack || e.agentId) return { ok: false, reason: 'replay' }
      if (now() - e.createdAt > ttlOf(e)) return { ok: false, reason: 'expired' }
      e.held = true
      return { ok: true }
    },
    /** Marks an unclaimed reply to wait for the turn's end (`true`) or to steer into it (`false`). */
    setWait(id, wait) {
      const e = entries.get(id)
      if (!e || e.withdrawn || e.claimed || e.ack || e.command || e.agentId) return false
      e.wait = wait === true
      return true
    },
    ack(id, cli, raw) {
      const e = entries.get(id)
      const a = /** @type {any} */ (raw)
      if (!e || e.cli !== cli || !a || !ACK_STATUSES.has(a.status)) return false
      e.ack = { status: a.status, reason: knownReason(a.reason), at: Number.isFinite(a.at) ? a.at : null }
      return true
    },
    /** The page's answer for one reply; a final one is forgotten once read. */
    result(id) {
      const e = entries.get(id)
      if (!e) return null
      if (!e.ack) return e.held && !e.claimed && !e.withdrawn ? { status: 'held', wait: e.wait, ...(e.command ? { command: true } : {}) } : { status: 'pending' }
      entries.delete(id)
      return e.ack
    },
    /** @returns {{ verdict: 'withdrawn' | 'delivered' | 'wait' | 'unknown', ack: { status: string, reason: string | null, at: number | null } | null } | null} */
    withdraw(id, isWaitOver) {
      const e = entries.get(id)
      if (!e) return null
      e.withdrawn = true
      const verdict = withdrawVerdict(e.claimed ? 'done' : 'pending', e.ack, isWaitOver)
      if (verdict === 'withdrawn' || verdict === 'delivered') entries.delete(id)
      return { verdict, ack: e.ack }
    },
    ackOf: id => entries.get(id)?.ack ?? null,
    expired(at) {
      const out = []
      for (const [id, e] of entries) {
        if (e.isExpiryLogged || e.ack || at - e.createdAt <= ttlOf(e)) continue
        e.isExpiryLogged = true
        out.push(id)
      }
      return out
    },
  }
}
