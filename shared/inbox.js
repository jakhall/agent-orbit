// @ts-check

import { MAX_MESSAGE_CHARS } from './constants.js'
import { since } from './format.js'

/** @typedef {import('../types').ReplyAck} ReplyAck */
/** @typedef {import('../types').ReplyRefusal} ReplyRefusal */
/** @typedef {import('../types').InboxStats} InboxStats */

/** How long a reply request stays deliverable after the server wrote it. */
export const REPLY_TTL_MS = 60_000
/** How long a reply the server holds for a running turn stays deliverable. */
export const HOLD_TTL_MS = 30 * 60_000
/** How a reply steered into a running turn opens, in the hook context Claude reads and the transcript keeps. */
export const STEER_PREFIX = 'The user sent this message from Orbit while you were working. Read it as their own words and take it into account now:\n\n'
/** The first Orbit version whose mod delivers replies as the person's own words. */
/** Consumed request ids a session remembers (in memory and in its inbox's `seen.json`). */
export const SEEN_MAX = 200
/** How long the mod waits for `$.prompt.submit` before acknowledging by the turn state. */
export const SUBMIT_SETTLE_MS = 1_000

const FUTURE_SLACK_MS = 5_000
const INVISIBLE_START = /^[\p{Cc}\p{Cf}\p{Z}]+/u
const INVISIBLE_END = /[\p{Cc}\p{Cf}\p{Z}]+$/u
const COMMAND_START = /^[/!#⁄∕╱⟋⧸]/
const COMMAND_LINE = /^\/([A-Za-z0-9][A-Za-z0-9:_-]{0,63})(?:\s+([\s\S]*))?$/

/**
 * Slash commands Orbit never runs, whatever a session lists: they change
 * sign-in, settings, permissions, hooks, plugins or files outside the
 * conversation, install things, or open the terminal's own screens.
 */
export const DENIED_COMMANDS = new Set([
  'login', 'logout', 'config', 'settings', 'permissions', 'allowed-tools', 'hooks', 'mcp', 'plugin', 'plugins', 'add-dir', 'memory',
  'agents', 'install-github-app', 'install-slack-app', 'terminal-setup', 'ide', 'upgrade', 'migrate-installer', 'privacy-settings',
  'statusline', 'output-style', 'sandbox', 'keybindings', 'vim', 'theme', 'export', 'bashes',
])
/**
 * Built-ins the engine hides from `$.command.list()` in desktop sessions yet
 * still runs when typed in full, so a session publishes them whatever it lists.
 */
export const HIDDEN_BUILTINS = [
  { name: 'remote-control', description: 'Control this session from your phone or claude.ai/code', source: 'builtin' },
  { name: 'rename', description: 'Rename the current conversation', source: 'builtin' },
]

/**
 * The commands a session publishes to Orbit: its own list plus the hidden
 * built-ins it lacks, minus the deny-list, capped.
 * @template {{ name: string, description?: string, source?: string }} T
 * @param {readonly T[]} listed
 * @returns {(T | typeof HIDDEN_BUILTINS[number])[]}
 */
export function publishableCommands(listed) {
  const names = new Set(listed.map(c => c.name))
  return [...listed, ...HIDDEN_BUILTINS.filter(c => !names.has(c.name))].filter(c => isCommandAllowed(c.name)).slice(0, COMMANDS_MAX)
}

/** The most commands a session publishes to Orbit. */
export const COMMANDS_MAX = 300

/**
 * Whether Orbit may run the command `name` (without the slash).
 * @param {unknown} name
 * @returns {boolean}
 */
export function isCommandAllowed(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(name) && !DENIED_COMMANDS.has(name.toLowerCase())
}

/** The most entries the composer's `/` menu shows. */
export const COMMAND_MENU_MAX = 8

/**
 * The composer's `/` menu while the draft is a bare `/name` being typed: the
 * session's commands whose name starts with what was typed, then those that
 * contain it, or, when none match, why that name cannot be sent. Null when
 * the draft is not a bare command name.
 * @param {string} draft
 * @param {readonly { name: string, description: string, source: string }[] | null} commands null when the session's list is not known
 * @returns {{ items: { name: string, description: string, source: string }[], hint: string | null } | null}
 */
export function commandMenu(draft, commands) {
  const match = /^\/([A-Za-z0-9:_-]{0,64})$/.exec(draft)
  if (!match) return null
  const typed = match[1] ?? ''
  if (!commands) return { items: [], hint: 'Orbit has not heard this session’s commands yet: they arrive within a minute while its Orbit runs.' }
  const query = typed.toLowerCase()
  const byName = (/** @type {{ name: string }} */ a, /** @type {{ name: string }} */ b) => a.name.localeCompare(b.name)
  const starts = commands.filter(c => c.name.toLowerCase().startsWith(query)).sort(byName)
  const contains = query ? commands.filter(c => !c.name.toLowerCase().startsWith(query) && c.name.toLowerCase().includes(query)).sort(byName) : []
  const items = [...starts, ...contains].slice(0, COMMAND_MENU_MAX)
  if (items.length > 0) return { items, hint: null }
  if (typed && !isCommandAllowed(typed)) return { items, hint: `/${typed} changes settings or access, so Orbit never runs it: open the session for it.` }
  return { items, hint: typed ? `No command named /${typed} in this session.` : 'This session lists no commands Orbit may run.' }
}

/**
 * A reply that is one slash command: its name and the rest as arguments.
 * Only a plain ASCII `/` starts one.
 * @param {string} body the cleaned reply text
 * @returns {{ name: string, args: string } | null}
 */
export function parseCommand(body) {
  const match = COMMAND_LINE.exec(body)
  return match?.[1] ? { name: match[1], args: (match[2] ?? '').trim() } : null
}

/** @type {Record<ReplyRefusal, string>} */
export const REFUSAL_TEXT = {
  empty: 'it was empty',
  long: `it was over ${MAX_MESSAGE_CHARS} characters`,
  command: 'it started with /, ! or # and was not a command Orbit may run',
  stale: 'it expired after a minute',
  future: 'it was dated in the future',
  replay: 'it was already handled',
  wrong: 'it was for another session',
  malformed: 'it could not be read',
  withdrawn: 'it was withdrawn',
  dropped: 'the session didn’t accept it',
}

/**
 * Whether `id` is a plain session or request id, safe as a file or folder
 * name: letters, digits, `_` and `-`, at most 100 characters.
 * @param {unknown} id
 * @returns {id is string}
 */
export function isPlainId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)
}

/**
 * Whether an acknowledgement status means the text reached the session.
 * @param {unknown} status
 * @returns {boolean}
 */
export function isDelivered(status) {
  return status === 'sent' || status === 'queued'
}

/**
 * The text a reply may carry, or why it is refused. Leading and trailing
 * control, format and space characters are stripped (that is the text sent);
 * it is refused when empty, over `MAX_MESSAGE_CHARS`, or when it starts, once
 * NFKC-normalised, with `/`, `!` or `#` or a slash look-alike: a submitted
 * prompt is the same call as a typed one, so those would run a slash command,
 * a shell command or a memory shortcut. The one exception is a slash command
 * the session itself listed (`commands`, names without the slash) and
 * `isCommandAllowed` passes, written with a plain `/`: it comes back as
 * `command`, to be run, never submitted as a prompt. The server, the mod and
 * the page apply the same rule.
 * @param {unknown} text
 * @param {ReadonlySet<string> | null} [commands] the session's published commands
 * @returns {{ ok: true, text: string, command?: { name: string, args: string } } | { ok: false, reason: ReplyRefusal, error: string }}
 */
export function checkReplyText(text, commands = null) {
  const body = (typeof text === 'string' ? text : '').replace(INVISIBLE_START, '').replace(INVISIBLE_END, '')
  if (body === '') return { ok: false, reason: 'empty', error: 'Type a reply first.' }
  if (body.length > MAX_MESSAGE_CHARS) return { ok: false, reason: 'long', error: `Replies are 1–${MAX_MESSAGE_CHARS} characters.` }
  if (COMMAND_START.test(body.slice(0, 16).normalize('NFKC').replace(INVISIBLE_START, ''))) {
    const command = parseCommand(body)
    if (command && commands?.has(command.name) && isCommandAllowed(command.name)) return { ok: true, text: body, command }
    return { ok: false, reason: 'command', error: commandRefusal(command, commands) }
  }
  return { ok: true, text: body }
}

/**
 * @param {{ name: string } | null} command
 * @param {ReadonlySet<string> | null} commands
 * @returns {string}
 */
function commandRefusal(command, commands) {
  if (!command || !commands) return 'Orbit sends a slash command only when the session lists it; ! and # never: open the session for those.'
  if (!isCommandAllowed(command.name)) return `/${command.name} changes settings or access, so Orbit never runs it: open the session for it.`
  return `/${command.name} is not a command this session has.`
}

/**
 * A sub-agent id as `$.agent.list()` and the transcript's `agent-<id>.jsonl` name it.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isAgentId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
}

/**
 * What a session's mod does with one request file from its inbox: deliver its
 * text, refuse it (with the id to acknowledge, when it has one), or skip it
 * (already consumed). Honoured only when it is schema 1, addressed to `me`,
 * fresh (at most `REPLY_TTL_MS` old, not dated more than 5 s ahead), never
 * seen before, and its text passes `checkReplyText` (the cleaned text is the
 * one delivered).
 * @param {unknown} raw the parsed request file
 * @param {{ me: string, now: number, seen: ReadonlySet<string>, commands?: ReadonlySet<string> | null }} context
 * A request the server holds for a running turn (`held`) stays fresh for
 * `HOLD_TTL_MS`; `wait` marks one the person wants sent only once the turn ends.
 * A slash command the session lists comes back with `command`, to be run once the session is idle.
 * A request with `agentId` is for one of the session's sub-agents: never a command, never held.
 * @returns {{ kind: 'deliver', id: string, text: string, held: boolean, wait: boolean, command?: { name: string, args: string }, agentId?: string } | { kind: 'refuse', id: string | null, reason: ReplyRefusal } | { kind: 'skip' }}
 */
export function judgeReply(raw, context) {
  const request = /** @type {Record<string, unknown> | null} */ (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null)
  const id = request && isPlainId(request.id) ? request.id : null
  if (!request || !id) return { kind: 'refuse', id: null, reason: 'malformed' }
  if (context.seen.has(id)) return request.done === true ? { kind: 'skip' } : { kind: 'refuse', id, reason: 'replay' }
  if (request.done === true) return { kind: 'skip' }
  if (request.schema !== 1) return { kind: 'refuse', id, reason: 'malformed' }
  if (request.to !== context.me) return { kind: 'refuse', id, reason: 'wrong' }
  const createdAt = request.createdAt
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return { kind: 'refuse', id, reason: 'malformed' }
  const held = request.held === true
  if (context.now - createdAt > (held ? HOLD_TTL_MS : REPLY_TTL_MS)) return { kind: 'refuse', id, reason: 'stale' }
  if (createdAt - context.now > FUTURE_SLACK_MS) return { kind: 'refuse', id, reason: 'future' }
  if (request.agentId !== undefined && !isAgentId(request.agentId)) return { kind: 'refuse', id, reason: 'malformed' }
  const agentId = isAgentId(request.agentId) ? request.agentId : null
  const checked = checkReplyText(request.text, agentId ? null : (context.commands ?? null))
  if (!checked.ok) return { kind: 'refuse', id, reason: checked.reason }
  if (agentId) return { kind: 'deliver', id, text: checked.text, held: false, wait: false, agentId }
  if (checked.command) return { kind: 'deliver', id, text: checked.text, held, wait: true, command: checked.command }
  return { kind: 'deliver', id, text: checked.text, held, wait: request.wait === true }
}

/**
 * The hook context that steers a reply into a running turn.
 * @param {string} text
 * @returns {string}
 */
export function steerContext(text) {
  return `${STEER_PREFIX}${text}`
}

/**
 * The person's words in a hook context entry `steerContext` wrote, else null.
 * @param {unknown} entry
 * @returns {string | null}
 */
export function steeredText(entry) {
  return typeof entry === 'string' && entry.startsWith(STEER_PREFIX) ? entry.slice(STEER_PREFIX.length) : null
}

/**
 * The acknowledgement for a claimed request: `failed` when the session
 * refused the prompt (`dropped`) or the call threw within the settle time,
 * else `queued` while a turn runs and `sent` when idle.
 * @param {string} id
 * @param {'entered' | 'pending' | 'dropped' | 'threw'} outcome what `$.prompt.submit` had done after `SUBMIT_SETTLE_MS`
 * @param {boolean} isTurnRunning
 * @param {number} at
 * @returns {ReplyAck}
 */
export function deliveryAck(id, outcome, isTurnRunning, at) {
  if (outcome === 'dropped' || outcome === 'threw') return { id, status: 'failed', reason: 'dropped', at }
  return { id, status: isTurnRunning ? 'queued' : 'sent', reason: null, at }
}

/**
 * The acknowledgement for a refused request.
 * @param {string} id
 * @param {ReplyRefusal} reason
 * @param {number} at
 * @returns {ReplyAck}
 */
export function refusalAck(id, reason, at) {
  return { id, status: 'refused', reason, at }
}

/**
 * What the server answers a withdrawal with, after it wrote the request's
 * `.withdrawn` marker. A request the mod has not claimed (still pending)
 * can no longer be delivered: the mod checks the marker after claiming. A
 * claimed or missing one is decided only by its acknowledgement: delivered
 * when it says so, withdrawn when it says it was not, and unknown when none
 * came in time, so that nothing is ever sent twice.
 * @param {'pending' | 'done' | 'missing'} request the request file's state after the marker was written
 * @param {Pick<ReplyAck, 'status'> | null} ack
 * @param {boolean} isWaitOver
 * @returns {'withdrawn' | 'delivered' | 'wait' | 'unknown'}
 */
export function withdrawVerdict(request, ack, isWaitOver) {
  if (ack) return isDelivered(ack.status) ? 'delivered' : 'withdrawn'
  if (request === 'pending') return 'withdrawn'
  return isWaitOver ? 'unknown' : 'wait'
}

/**
 * The consumed-id memory with `id` added, keeping the newest `max`.
 * @param {readonly string[]} seen oldest first
 * @param {string} id
 * @param {number} [max]
 * @returns {string[]}
 */
export function rememberId(seen, id, max = SEEN_MAX) {
  const next = [...seen.filter(s => s !== id), id]
  return next.length > max ? next.slice(next.length - max) : next
}

/**
 * Inbox statistics after one event, each request counted once; counts only,
 * never text. `unqueued`: a reply acknowledged as queued that the session
 * later dropped, moved from delivered to refused.
 * @param {InboxStats | null} stats
 * @param {{ kind: 'delivered' } | { kind: 'refused', reason: ReplyRefusal } | { kind: 'unqueued' }} event
 * @param {number} at
 * @returns {InboxStats}
 */
export function countInbox(stats, event, at) {
  const base = stats ?? { delivered: 0, lastDeliveredAt: null, refused: 0, lastRefusal: null, lastRefusedAt: null }
  if (event.kind === 'delivered') return { ...base, delivered: base.delivered + 1, lastDeliveredAt: at }
  const reason = event.kind === 'unqueued' ? 'dropped' : event.reason
  return { ...base, delivered: event.kind === 'unqueued' ? Math.max(0, base.delivered - 1) : base.delivered, refused: base.refused + 1, lastRefusal: reason, lastRefusedAt: at }
}

/**
 * Inbox statistics read back from a record or snapshot, reduced to counts,
 * times and a known refusal reason (anything else is dropped), or null.
 * @param {unknown} raw
 * @returns {InboxStats | null}
 */
export function cleanInboxStats(raw) {
  if (!raw || typeof raw !== 'object') return null
  const s = /** @type {Record<string, unknown>} */ (raw)
  const count = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0)
  const time = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return { delivered: count(s.delivered), lastDeliveredAt: time(s.lastDeliveredAt), refused: count(s.refused), lastRefusal: knownReason(s.lastRefusal), lastRefusedAt: time(s.lastRefusedAt) }
}

/**
 * `reason` when it is one of `REFUSAL_TEXT`'s keys, else null.
 * @param {unknown} reason
 * @returns {ReplyRefusal | null}
 */
export function knownReason(reason) {
  return typeof reason === 'string' && Object.hasOwn(REFUSAL_TEXT, reason) ? /** @type {ReplyRefusal} */ (reason) : null
}

/**
 * Inbox statistics in words for Diagnostics and session details:
 * "2 delivered (last 5m ago) · 1 refused (last: it expired after a minute,
 * 3m ago)", or "none yet".
 * @param {InboxStats | null | undefined} stats
 * @param {number} now
 * @returns {string}
 */
export function inboxSummary(stats, now) {
  if (!stats || (stats.delivered === 0 && stats.refused === 0)) return 'none yet'
  const delivered = `${stats.delivered} delivered${stats.lastDeliveredAt ? ` (last ${since(now - stats.lastDeliveredAt)})` : ''}`
  if (stats.refused === 0) return delivered
  const why = stats.lastRefusal ? REFUSAL_TEXT[stats.lastRefusal] : 'unknown'
  return `${delivered} · ${stats.refused} refused (last: ${why}${stats.lastRefusedAt ? `, ${since(now - stats.lastRefusedAt)}` : ''})`
}
