// @ts-check

import { isHiddenNow, isUrgent, rankSessions } from './filters.js'
import { layoutGraph } from './layout.js'
import { ago, clockTime, duration, plural, since, truncate } from './format.js'
import { APPROVAL_ARM_MS } from './approvals.js'
import { HOLD_TTL_MS, isDelivered, knownReason, REFUSAL_TEXT, REPLY_TTL_MS } from './inbox.js'
import { MOD_VERSION } from './constants.js'

/** @typedef {import('../types').SessionView} SessionView */
/** @typedef {import('../types').ConversationRow} ConversationRow */
/** @typedef {import('../types').TaskStep} TaskStep */
/** @typedef {import('../types').ReplyAck} ReplyAck */
/** @typedef {import('./filters.js').VisibleView} VisibleView */

/**
 * @typedef {object} Send a message the chat sent, or is sending, to one session
 * @property {string} key the session key
 * @property {string} draft the message's text
 * @property {'sending' | 'waiting' | 'expired' | 'held' | 'sent' | 'queued' | 'failed' | 'unknown'} status
 *   `waiting`: a reply has had no acknowledgement for 15 s; `expired`: none within its minute;
 *   `held`: the session holds it for its running turn, still withdrawable;
 *   `sent`: a reply arrived (or is queued) as the person's words; `unknown`: it may have arrived, so it is never offered for sending again
 * @property {string | null} message the server's answer, shown under the box
 * @property {string} [replyId] the reply request being waited on
 * @property {number} [createdAt] when the server wrote that request
 * @property {number} [sentAt] when the page sent it
 * @property {number} [settledAt] when it was delivered, queued or refused
 * @property {string} [reason] the underlying error, kept for the tooltip
 * @property {boolean} [wait] a held reply waits for the turn to end instead of steering into it
 */

/** @typedef {'reply' | 'older' | 'off'} SendMode */

/**
 * @typedef {object} Viewed when this viewer last looked at each session's details
 * @property {number} since the baseline: changes before it count as seen
 * @property {Record<string, number>} at session key → when it was last viewed
 */

export const DRAFT_SESSIONS = 12
export const QUEUE_ROWS = 20
export const SWITCHER_ROWS = 40

/**
 * The unsent text kept for one session's message box, or ''.
 * @param {ReadonlyMap<string, string>} drafts
 * @param {string} key
 * @returns {string}
 */
export function draftOf(drafts, key) {
  return drafts.get(key) ?? ''
}

/**
 * Keeps `text` as session `key`'s draft, as the most recent one (an empty
 * text drops it), and forgets the oldest drafts past `max` sessions.
 * Changes `drafts` in place.
 * @param {Map<string, string>} drafts
 * @param {string} key
 * @param {string} text
 * @param {number} [max]
 */
export function setDraft(drafts, key, text, max = DRAFT_SESSIONS) {
  drafts.delete(key)
  if (text) drafts.set(key, text)
  while (drafts.size > max) {
    const oldest = drafts.keys().next()
    if (oldest.done) break
    drafts.delete(oldest.value)
  }
}

/**
 * Session `key`'s message box state: `send` when it belongs to that session,
 * otherwise null (a plain box showing the session's own draft).
 * @param {Send | null} send
 * @param {string} key
 * @returns {Send | null}
 */
export function sendOf(send, key) {
  return send && send.key === key ? send : null
}

/**
 * The message box state after session `key`'s send moved on: `next` while that
 * session is open, and also while it is not but the box still holds its send,
 * so a reply settled with another session, a project or nothing open never
 * leaves a stale "Waiting for the session…" behind (2.1.9); another session's
 * send stays.
 * @param {Send | null} current
 * @param {string} key
 * @param {Send | null} next
 * @param {boolean} isOpen session `key` is the selected one
 * @returns {Send | null}
 */
export function sendUpdate(current, key, next, isOpen) {
  return isOpen || current?.key === key ? next : current
}

/**
 * When a session last changed in a way worth a look: a new state or the end
 * of a turn.
 * @param {SessionView} s
 * @returns {number}
 */
export function changedAt(s) {
  return Math.max(s.stateSince ?? 0, s.finishedAt ?? 0)
}

/**
 * Whether a session's details offer a reply: it needs you (not just for a
 * failing PR), can take a message from Orbit, and has a transcript to quote.
 * @param {SessionView} s
 * @returns {boolean}
 */
export function isReplyWanted(s) {
  return Boolean(s.cliSessionId && s.canMessage && isUrgent(s) && s.attention !== 'pr')
}

/**
 * Whether the details should fetch a session's conversation: it has a
 * transcript and this viewer shows conversation text (the chat is always
 * open for such a session; with the text hidden nothing is fetched).
 * @param {SessionView} s
 * @param {boolean} showsText the *Conversation text* setting
 * @returns {boolean}
 */
export function isConversationWanted(s, showsText) {
  return Boolean(s.cliSessionId) && showsText
}

/**
 * The message a reply answers: Claude's last reply or question after your
 * last prompt; null when Claude has not spoken since.
 * @param {readonly ConversationRow[]} rows
 * @returns {ConversationRow | null}
 */
export function replyQuote(rows) {
  const lastPrompt = rows.findLastIndex(r => r.who === 'you')
  return rows.findLast((r, i) => (r.who === 'claude' || r.who === 'question') && i > lastPrompt) ?? null
}

/**
 * The quick switcher's rows for `query`: the matches among sessions Orbit
 * shows (`rankSessions` order), then the hidden ones, at most `max`; `total`
 * and `hidden` count every match.
 * @param {readonly SessionView[]} sessions every session in the snapshot
 * @param {Readonly<Record<string, number>>} hidden the `hidden` preference
 * @param {string} query
 * @param {(session: SessionView) => string} projectName
 * @param {readonly SessionView[]} attention the Needs you list, most urgent first
 * @param {number} [max]
 * @returns {{ items: SessionView[], total: number, hidden: number }}
 */
export function switcherResults(sessions, hidden, query, projectName, attention, max = SWITCHER_ROWS) {
  const shown = rankSessions(sessions.filter(s => !isHiddenNow(s, hidden)), query, projectName, attention)
  const hiddenOnes = rankSessions(sessions.filter(s => isHiddenNow(s, hidden)), query, projectName, attention)
  return { items: [...shown, ...hiddenOnes].slice(0, max), total: shown.length + hiddenOnes.length, hidden: hiddenOnes.length }
}

/**
 * A switcher row's second line, project · branch · last activity, and its
 * tag for a session Orbit is not showing: "Hidden" (hidden until active) or
 * "Filtered" (outside the current filters).
 * @param {SessionView} s
 * @param {string} project
 * @param {number} now
 * @param {{ isHidden: boolean, isListed: boolean }} shown
 * @returns {{ meta: string, tag: 'Hidden' | 'Filtered' | null }}
 */
export function switcherRowMeta(s, project, now, shown) {
  return {
    meta: [project, s.branch, ago(now - s.lastActivityAt)].filter(Boolean).join(' · '),
    tag: shown.isHidden ? 'Hidden' : shown.isListed ? null : 'Filtered',
  }
}

/**
 * The switcher's status line: how many sessions match, and how many of them
 * are hidden.
 * @param {number} total
 * @param {number} hidden
 * @returns {string}
 */
export function switcherStatus(total, hidden) {
  return total === 0 ? 'No sessions match' : `${plural(total, 'session')}${hidden ? ` · ${hidden} hidden` : ''}`
}

/**
 * Whether the message box can send to `s`: `reply` (as the person, the one
 * route) when the viewer turned replies on and the session runs Orbit 1.9 or
 * later; `older` when the session's Orbit cannot take replies (whatever the
 * setting, since turning replies on would not help); else `off`.
 * @param {SessionView} s
 * @param {boolean} wantsReplies
 * @returns {SendMode}
 */
export function sendMode(s, wantsReplies) {
  const publisher = /** @type {{ replyProtocol?: number } | null | undefined} */ (s.publisher)
  if (publisher?.replyProtocol !== 2) return 'older'
  return wantsReplies ? 'reply' : 'off'
}

/**
 * What the message box's button does for `s`: `stop` (its running turn) when
 * the box is empty, the session is working and its Orbit takes stops, with
 * replies on; else `send`, so typed text still queues as in Claude.
 * @param {SessionView} s
 * @param {boolean} wantsReplies
 * @param {boolean} hasText
 * @returns {'stop' | 'send'}
 */
export function composerButton(s, wantsReplies, hasText) {
  const publisher = /** @type {{ stopProtocol?: number } | null | undefined} */ (s.publisher)
  if (hasText || publisher?.stopProtocol !== 1 || sendMode(s, wantsReplies) !== 'reply') return 'send'
  return s.lifecycle === 'running' ? 'stop' : 'send'
}

/** @type {Record<string, string>} */
const STOP_TEXT = {
  pending: 'Stopping…',
  stopped: 'Stopped.',
  idle: 'Nothing was running to stop.',
  failed: 'Not stopped. Open the session in Claude to stop it.',
  expired: 'Not stopped: the session didn’t answer. Open it in Claude to stop it.',
}
const STOP_UNKNOWN = 'May not have stopped. Check the session.'

/**
 * The status line for a stop request's state.
 * @param {string} status
 * @returns {string}
 */
export function stopText(status) {
  return STOP_TEXT[status] ?? STOP_UNKNOWN
}

export const REPLY_OLDER_TEXT = 'Not sent: this session’s Orbit is too old for replies. Open it in Claude.'

/** @type {Record<Exclude<SendMode, 'reply'>, { short: string, text: string }>} */
const SEND_BLOCK = {
  off: { short: 'Replies are off.', text: 'Replies as me is off, so Orbit can’t send to sessions. Turn it on in Settings (it applies to every Orbit window) to reply here.' },
  older: { short: 'Can’t message this session from Orbit: open it in Claude.', text: 'This session doesn’t run Orbit 1.9 or later, so it can’t take replies from here. Open it in Claude to message it.' },
}

/**
 * The line shown in the message box's place when `mode` cannot send, or null.
 * @param {SendMode} mode
 * @returns {{ short: string, text: string } | null}
 */
export function sendBlock(mode) {
  return mode === 'reply' ? null : SEND_BLOCK[mode]
}

/**
 * The message box after a reply's acknowledgement: `sent` with no line under
 * it (2.1.9) or "Queued as you: sends when the session is idle.", else `failed` with the
 * session's reason in the person's terms. A `command` refusal from a session
 * whose Orbit differs from the page's names that version: its text rules may
 * be older than the page's (a leading `#`, 2.4.4).
 * @param {string} key
 * @param {Pick<ReplyAck, 'status' | 'reason'>} ack
 * @param {string} draft the text, kept for another try when it was not sent
 * @param {string | null} [modVersion] the session's Orbit version
 * @returns {Send}
 */
export function sendAfterAck(key, ack, draft, modVersion = null) {
  if (ack.status === 'sent') return { key, draft: '', status: 'sent', message: '' }
  if (ack.status === 'queued') return { key, draft: '', status: 'sent', message: 'Queued as you: sends when the session is idle.' }
  const reason = knownReason(ack.reason)
  if (reason === 'command' && modVersion && modVersion !== MOD_VERSION) return { key, draft, status: 'failed', message: `Not sent: this session runs Orbit ${modVersion}, which refuses it. A session started now takes it.` }
  return { key, draft, status: 'failed', message: `Not sent: ${reason ? REFUSAL_TEXT[reason] : 'the session didn’t accept it'}.` }
}

/** @type {Record<import('../types').MessageBlock, string>} */
const READ_ONLY_TEXT = {
  asleep: 'This session is asleep: Claude desktop stopped it while idle. Send it a message in Claude desktop to wake it, then reply here.',
  ended: 'Read only: this session has ended, so it can’t take messages.',
  'no-id': 'Read only: Orbit has no Claude Code id for this session, so it can’t take messages.',
}

/** @type {Record<import('../types').MessageBlock, string>} */
const READ_ONLY_SHORT = {
  asleep: 'Asleep. Wake it from Claude desktop to reply here.',
  ended: 'Ended: read only.',
  'no-id': 'Read only: no Claude Code id.',
}

/**
 * Why the chat is read only, in words: from `messageBlock`, or the ended
 * wording for a snapshot written before 1.13.1 (which has none).
 * @param {Pick<SessionView, 'messageBlock'>} s
 * @returns {string}
 */
export function readOnlyText(s) {
  return READ_ONLY_TEXT[s.messageBlock ?? 'ended'] ?? READ_ONLY_TEXT.ended
}

/**
 * `readOnlyText` in a few words, for the line in the composer's place (the
 * full sentence goes in its tooltip).
 * @param {Pick<SessionView, 'messageBlock'>} s
 * @returns {string}
 */
export function readOnlyShort(s) {
  return READ_ONLY_SHORT[s.messageBlock ?? 'ended'] ?? READ_ONLY_SHORT.ended
}

export const NO_WINDOW_TEXT = 'Reconnecting to Orbit: try again in a moment.'

/**
 * Whether a failed acting call was refused only because the server saw no
 * open window (409 `no-window`, while this window's event stream reconnects),
 * not because of the request itself.
 * @param {number | undefined} status
 * @param {{ reason?: unknown, [key: string]: unknown } | null | undefined} detail
 */
export function isNoWindow(status, detail) {
  return status === 409 && detail?.reason === 'no-window'
}

/**
 * The `POST /api/stats` body that reports a painted schema 2 snapshot, for
 * the server's event-to-paint latency; null without a whole-number seq and a bootId.
 * @param {{ seq?: unknown, bootId?: unknown, [key: string]: unknown } | null | undefined} stamps
 * @param {number} at
 * @returns {{ painted: { seq: number, bootId: string, at: number } } | null}
 */
export function paintedStats(stamps, at) {
  if (!stamps || !Number.isSafeInteger(stamps.seq) || typeof stamps.bootId !== 'string') return null
  return { painted: { seq: /** @type {number} */ (stamps.seq), bootId: stamps.bootId, at } }
}

/**
 * What the page does after asking the server to withdraw a reply: put the
 * text back (only when the server confirmed nothing went), show the delivery
 * instead, or say it may have arrived. A 404 means the server no longer
 * knows the reply, which is never treated as safe.
 * @param {{ status?: unknown } | null} answer the server's answer, or null when it failed
 * @param {number | null} errorStatus the HTTP status of a failed answer
 * @returns {'withdrawn' | 'delivered' | 'unknown'}
 */
export function withdrawOutcome(answer, errorStatus) {
  if (errorStatus !== null || !answer) return 'unknown'
  if (answer.status === 'withdrawn') return 'withdrawn'
  return isDelivered(answer.status) ? 'delivered' : 'unknown'
}

/**
 * When a reply waited on without an acknowledgement counts as expired: its
 * minute (half an hour once the session holds it for its turn) plus 10 s of
 * slack for the session's next poll.
 * @param {number} createdAt
 * @param {boolean} [isHeld]
 * @returns {number}
 */
export function replyDeadline(createdAt, isHeld = false) {
  return createdAt + (isHeld ? HOLD_TTL_MS : REPLY_TTL_MS) + 10_000
}

export const REMOTE_SWITCH_WAIT_MS = 30_000

/**
 * Why Orbit cannot run `/<name>` in session `s` now, or null when it can: it
 * needs a live session that takes replies, a current mod, Replies as me and
 * the command in the session's list.
 * @param {Pick<SessionView, 'canMessage' | 'messageBlock'> & { publisher?: unknown }} s
 * @param {{ armed: boolean, listed: boolean | null, name: string, doing: string }} context `listed` is null until the session's commands are known; `doing` finishes "Turn on Replies as me in Settings to …"
 * @returns {string | null}
 */
export function commandBlock(s, { armed, listed, name, doing }) {
  if (!s.canMessage) return readOnlyText(s)
  if (/** @type {{ replyProtocol?: number } | null | undefined} */ (s.publisher)?.replyProtocol !== 2) return REPLY_OLDER_TEXT
  if (!armed) return `Turn on Replies as me in Settings to ${doing}.`
  if (listed === null) return 'Orbit has not heard this session’s commands yet.'
  if (!listed) return `This session does not list /${name}.`
  return null
}


/**
 * The panel's Remote Control switch for `s`: whether it shows on, whether it
 * can be pressed (and why not), and the line beside it. Pressing it asks the
 * session to run `/remote-control`, which works only when replies are armed
 * and the session lists that command; the desktop record then says whether
 * it flipped. `pending` is the press still waiting for that flip.
 * @param {Pick<SessionView, 'remoteControl' | 'canMessage' | 'messageBlock' | 'publisher'>} s
 * @param {{ armed: boolean, listed: boolean | null, pending: { from: boolean, at: number } | null, now: number }} context `listed`: null while the session's commands are not known
 * @returns {{ on: boolean, disabled: boolean, reason: string | null, note: string | null, settled: boolean }} `settled`: the pending press is over (flipped, or given up)
 */
export function remoteSwitchState(s, { armed, listed, pending, now }) {
  const on = s.remoteControl === true
  const flipped = pending !== null && typeof s.remoteControl === 'boolean' && s.remoteControl !== pending.from
  const timedOut = pending !== null && !flipped && now - pending.at >= REMOTE_SWITCH_WAIT_MS
  const settled = flipped || timedOut
  const waiting = pending !== null && !settled
  const reason = typeof s.remoteControl !== 'boolean' ? 'Orbit cannot read this session’s Remote Control state.' : commandBlock(s, { armed, listed, name: 'remote-control', doing: 'switch Remote Control from here' })
  const note = waiting ? 'Switching…' : timedOut ? 'No change: open the session to switch it there.' : null
  return { on, disabled: reason !== null || waiting, reason, note, settled }
}

/**
 * The line under a reply the session holds for its running turn.
 * @param {boolean} wait
 * @returns {string}
 */
export function heldText(wait) {
  return wait ? 'Queued: sends when Claude finishes.' : 'Queued: Claude reads it after its current step.'
}

export const CHAT_ROWS_MAX = 500
export const CHAT_MIN_PX = 200
export const DETAILS_MIN_PX = 96
export const BUBBLE_KEEP_MS = 10 * 60_000
export const ECHO_SLACK_MS = 5_000

/**
 * Where the chat's live window starts: the line of the newest row held (only
 * that row can still grow: more text, more tool calls); null when it has no
 * offset.
 * @param {readonly ConversationRow[]} rows
 * @returns {number | null}
 */
export function liveFrom(rows) {
  const o = rows.at(-1)?.o
  return typeof o === 'number' ? o : null
}

/**
 * The desktop task list as it stands at the end of `rows`, folded from their
 * `plan` rows: a list of items replaces it, `advance` completes the step in
 * progress and starts the next pending one, `done` and `start` (1-based)
 * mark steps, and the next-step box checks every step off. A prompt after a
 * finished list clears it; one during an unfinished list (a message sent
 * mid-turn) keeps it. Null when there is no list.
 * @param {readonly ConversationRow[]} rows
 * @returns {TaskStep[] | null}
 */
export function taskList(rows) {
  /** @type {TaskStep[] | null} */
  let steps = null
  for (const r of rows) {
    if (r.who === 'you' && steps?.every(s => s.status === 'completed')) steps = null
    const op = r.who === 'plan' ? r.plan : undefined
    if (!op) continue
    if (op.items) steps = op.items.length ? op.items.map(s => ({ ...s })) : null
    if (!steps) continue
    const list = steps
    const set = (/** @type {number} */ i, /** @type {TaskStep['status']} */ status) => {
      const step = list[i]
      if (step) step.status = status
    }
    if (op.advance) {
      const current = list.findIndex(s => s.status === 'in_progress')
      if (current >= 0) set(current, 'completed')
      const next = list.findIndex((s, i) => i > current && s.status === 'pending')
      if (next >= 0) set(next, 'in_progress')
    }
    for (const n of op.done ?? []) set(n - 1, 'completed')
    if (op.start !== undefined) set(op.start - 1, 'in_progress')
    if (op.finish) for (const s of list) s.status = 'completed'
  }
  return steps
}

/**
 * Whether row `a` comes after row `b` in the transcript (by line offset,
 * then by place on the line).
 * @param {ConversationRow} a
 * @param {ConversationRow} b
 * @returns {boolean}
 */
export function isRowAfter(a, b) {
  const ao = a.o ?? -1
  const bo = b.o ?? -1
  return ao > bo || (ao === bo && (a.i ?? 0) > (b.i ?? 0))
}

/**
 * The rows after an answer for the live window from `from`: the rows held
 * before it, then the answer's rows. Past `max` the oldest are dropped.
 * `added` counts the answer's messages (not tool or event lines) newer than
 * every row held before, for the "New messages" button.
 * @param {readonly ConversationRow[]} rows
 * @param {readonly ConversationRow[]} incoming
 * @param {number} from
 * @param {number} [max]
 * @returns {{ rows: ConversationRow[], added: number, dropped: number }}
 */
export function mergeLive(rows, incoming, from, max = CHAT_ROWS_MAX) {
  const newest = rows.at(-1)
  const merged = [...rows.filter(r => (r.o ?? -1) < from), ...incoming]
  const dropped = Math.max(0, merged.length - max)
  const added = incoming.filter(r => (!newest || isRowAfter(r, newest)) && r.who !== 'tools' && r.who !== 'event' && r.who !== 'plan').length
  return { rows: merged.slice(dropped), added, dropped }
}

/**
 * The rows after an older page: its rows from before the first row held,
 * then the rows held. Past `max` the newest are dropped (`dropped` > 0), so
 * the page is no longer joined to the live end until the tail is reloaded.
 * @param {readonly ConversationRow[]} rows
 * @param {readonly ConversationRow[]} incoming
 * @param {number} [max]
 * @returns {{ rows: ConversationRow[], dropped: number }}
 */
export function mergeOlder(rows, incoming, max = CHAT_ROWS_MAX) {
  const first = rows[0]?.o ?? Infinity
  const merged = [...incoming.filter(r => (r.o ?? Infinity) < first), ...rows]
  const dropped = Math.max(0, merged.length - max)
  return { rows: merged.slice(0, merged.length - dropped), dropped }
}

/**
 * The composer's accessible name, read by screen readers only: "To <title cut to 32> · as you".
 * @param {string} title
 * @returns {string}
 */
export function composerLabel(title) {
  const short = title.length > 32 ? `${title.slice(0, 31).trimEnd()}…` : title
  return `To ${short} · as you`
}

/**
 * The composer's visible route: its placeholder.
 * @returns {{ placeholder: string }}
 */
export function composerHint() {
  return { placeholder: 'Reply as you' }
}

/**
 * Whether Orbit can wake `s`: an asleep desktop session it can open. Opening
 * it makes Claude desktop restart its process; its message box stays locked
 * until then.
 * @param {Pick<SessionView, 'messageBlock' | 'canOpen'>} s
 * @returns {boolean}
 */
export function canWake(s) {
  return s.messageBlock === 'asleep' && s.canOpen === true
}

export const WAKE_HOLD_MS = 60_000

/**
 * The asleep card's words and its moon button's name: `asleep` before the
 * moon is pressed; `waking` for `WAKE_HOLD_MS` after, while Claude desktop
 * restarts the session; `stalled` when it is still asleep after that;
 * `failed` when Orbit could not open it, with `error` saying why.
 * @param {'asleep' | 'waking' | 'stalled' | 'failed'} phase
 * @param {string | null} [error]
 * @returns {{ title: string, line: string, label: string }}
 */
export function asleepCardText(phase, error = null) {
  if (phase === 'waking') return { title: 'Waking up…', line: 'Claude desktop is restarting it. This can take a minute.', label: 'Waking…' }
  if (phase === 'stalled') return { title: 'Still asleep', line: 'Claude desktop hasn’t restarted it yet. Press to try again.', label: 'Try waking it again' }
  if (phase === 'failed') return { title: 'Couldn’t wake it', line: `${error ?? 'Orbit couldn’t open it in Claude desktop.'} Press to try again.`, label: 'Try waking it again' }
  return { title: 'Asleep', line: 'Paused while idle. Press to wake up.', label: 'Wake up' }
}

/**
 * The desktop's suggested next prompt to show dim in the empty composer
 * (Tab takes it), or null: only with conversation text on, while the
 * session is idle, holds a suggestion, asks no question and no message of
 * Orbit's is in flight.
 * @param {{ hasSuggestion?: boolean, lifecycle?: string }} s
 * @param {{ text: string | null | undefined, showConvo: boolean, isBusy: boolean, isAsking: boolean }} context
 * @returns {string | null}
 */
export function shownSuggestion(s, { text, showConvo, isBusy, isAsking }) {
  if (!showConvo || s.hasSuggestion !== true || s.lifecycle === 'running' || isBusy || isAsking) return null
  return typeof text === 'string' && text.trim() !== '' ? text : null
}

/**
 * The empty composer's dim text: a held question's prompt first, then the
 * desktop's suggestion (Tab takes it, asleep or awake), then the asleep note,
 * then the usual hint.
 * @param {{ isAsking: boolean, suggestion: string | null, canMessage: boolean }} at
 * @param {{ usual: string, asleep: string, question: string }} texts
 */
export function composerPlaceholder({ isAsking, suggestion, canMessage }, { usual, asleep, question }) {
  if (isAsking) return question
  if (suggestion) return suggestion
  return canMessage ? usual : asleep
}

/**
 * Whether the page should ask the server for the session's suggestion: it
 * says it holds one and the conversation may be shown.
 * @param {{ hasSuggestion?: boolean, lifecycle?: string }} s
 * @param {boolean} showConvo
 */
export function wantsSuggestion(s, showConvo) {
  return showConvo && s.hasSuggestion === true && s.lifecycle !== 'running'
}

/**
 * The chat header's prompt count: "N prompts" once the rows held reach the
 * start of the conversation and its end, else "N+ prompts" (more may be
 * further back), with a tooltip saying which.
 * @param {readonly ConversationRow[]} rows
 * @param {boolean} isComplete the rows run from the start of the conversation to its newest row
 * @returns {{ text: string, title: string }}
 */
export function promptCount(rows, isComplete) {
  const n = rows.filter(r => r.who === 'you').length
  return isComplete ? { text: plural(n, 'prompt'), title: 'Prompts in this conversation' } : { text: `${Math.max(n, 1)}+ prompts`, title: 'Prompts loaded so far' }
}

export const TURN_GAP_MS = 10 * 60_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * @param {number} at
 * @returns {string} the local calendar day of `at`
 */
function dayKey(at) {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/**
 * A day divider's words for the local day of `at`: "Today", "Yesterday",
 * else "Mon 9 Nov" (with the year when it is not this year's).
 * @param {number} at
 * @param {number} now
 * @returns {string}
 */
export function dayLabel(at, now) {
  const today = new Date(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const key = dayKey(at)
  if (key === dayKey(now)) return 'Today'
  if (key === dayKey(yesterday.getTime())) return 'Yesterday'
  const d = new Date(at)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === today.getFullYear() ? '' : ` ${d.getFullYear()}`}`
}

/**
 * @typedef {object} ChatMark how the chat draws one row among its neighbours
 * @property {string | null} day a day divider before the row, or null
 * @property {boolean} head the row shows its speaker and time ("Claude · 08:16")
 * @property {boolean} turn the row starts a turn (more space above it)
 */

/**
 * How the chat groups its rows, one mark per row. A day divider goes before
 * the first timed row when it is not from today, and wherever the local day
 * changes from the previous timed row. A Claude reply shows its header only
 * when it starts a turn: the previous row that is not a tool line is not a
 * Claude reply, or the last header shown is more than `gapMs` earlier, or a
 * divider is right above it. A question always shows its header. Your
 * prompts and events start a turn but never show a header.
 * @param {readonly ConversationRow[]} rows
 * @param {number} now
 * @param {number} [gapMs]
 * @returns {ChatMark[]}
 */
export function chatMarks(rows, now, gapMs = TURN_GAP_MS) {
  /** @type {ChatMark[]} */
  const marks = []
  /** @type {string | null} */
  let lastDay = null
  /** @type {ConversationRow['who'] | null} */
  let lastSpeaker = null
  /** @type {number | null} */
  let lastHeadAt = null
  const today = dayKey(now)
  for (const r of rows) {
    const key = r.at !== null ? dayKey(r.at) : null
    const isNewDay = key !== null && (lastDay === null ? key !== today : key !== lastDay)
    const day = isNewDay && r.at !== null ? dayLabel(r.at, now) : null
    if (key !== null) lastDay = key
    if (r.who === 'tools') {
      marks.push({ day, head: false, turn: day !== null })
      continue
    }
    const isGap = r.at !== null && lastHeadAt !== null && r.at - lastHeadAt > gapMs
    const head = r.who === 'question' || (r.who === 'claude' && (lastSpeaker !== 'claude' || isGap || day !== null))
    if (head) lastHeadAt = r.at ?? lastHeadAt
    lastSpeaker = r.who
    marks.push({ day, head, turn: head || r.who === 'you' || r.who === 'event' })
  }
  return marks
}

export const PIN_VISIBLE_PX = 12
export const PIN_COVER_PX = 56

/**
 * Which of your prompts the chat pins above its message list: the last one
 * whose row starts above the top of the view (the prompt that started the
 * turn in view). No bar while at least `minVisiblePx` of that row is still
 * in view, or while the next prompt starts within the top `coverPx` (the bar
 * would cover the start of the next turn). At the end of a long turn whose
 * prompt scrolled out, that is the newest prompt; with no prompt above the
 * view, none.
 * @param {readonly { top: number, bottom: number }[]} prompts your prompt rows in order, edges in px from the top of the view
 * @param {number} [coverPx]
 * @param {number} [minVisiblePx]
 * @returns {number | null} the index into `prompts`, or null for no bar
 */
export function pinnedPrompt(prompts, coverPx = PIN_COVER_PX, minVisiblePx = PIN_VISIBLE_PX) {
  const pick = prompts.findLastIndex(p => p.top < 0)
  const pinned = prompts[pick]
  if (!pinned || pinned.bottom >= minVisiblePx) return null
  const next = prompts[pick + 1]
  return next && next.top < coverPx ? null : pick
}

/**
 * @param {string} text
 * @returns {string}
 */
function sameShape(text) {
  return text.trim().replace(/\s+/g, ' ')
}

/**
 * The pending bubble the chat shows for `send`, or null. A reply that
 * arrived goes once the transcript shows a prompt with the same text
 * (trimmed, whitespace collapsed) from its send time on; anything delivered
 * or queued goes `BUBBLE_KEEP_MS` after it settled (a note never shows in
 * the transcript).
 * @param {Send | null} send
 * @param {readonly ConversationRow[] | null} rows
 * @param {number} now
 * @returns {Send | null}
 */
export function chatBubble(send, rows, now) {
  if (!send) return null
  const text = send.draft
  if (send.status === 'sent' && rows && text) {
    const sentAt = (send.sentAt ?? 0) - ECHO_SLACK_MS
    const shape = sameShape(text)
    if (rows.some(r => r.who === 'you' && r.at !== null && r.at >= sentAt && sameShape(r.text) === shape)) return null
  }
  if ((send.status === 'sent' || send.status === 'queued') && send.settledAt !== undefined && now - send.settledAt >= BUBBLE_KEEP_MS) return null
  return send
}

const AWAITING_AGENT = new Set(['sending', 'waiting', 'held', 'queued', 'sent'])

/**
 * Whether a sent message is still on its way to the agent or waiting for it
 * to take it in (a spinner beside the bubble), rather than refused, expired
 * or of unknown fate.
 * @param {Send['status']} status
 * @returns {boolean}
 */
export function isAwaitingAgent(status) {
  return AWAITING_AGENT.has(status)
}

/**
 * @typedef {object} QuestionDraft one question's choices on the page, before sending
 * @property {string[]} labels the options ticked (one at most for a single-select question)
 * @property {boolean} isOther "Other" is chosen
 * @property {string} other the Other text
 * @property {string} note the optional note
 */

/**
 * Whether a question card that just appeared may take the keyboard focus:
 * only when focus is already in the request slot it replaces (the card before
 * it just ended), never from the page body, where Space scrolls and would
 * otherwise choose an option (S1), nor from the details, the composer or a
 * text field. Every other card is announced instead.
 * @param {{ isBody: boolean, isInDetails: boolean, isInComposer: boolean, isTextField: boolean, isInRequests?: boolean }} focus
 * @returns {boolean}
 */
export function mayFocusNewCard(focus) {
  return Boolean(focus.isInRequests) && !focus.isTextField && !focus.isInComposer
}

/**
 * Whether a question card's Send may be pressed: only APPROVAL_ARM_MS after
 * the panel holding it showed (`armFrom`), so no run of keys answers a
 * request the moment it reaches the screen (S1, review §4.5).
 * @param {number | null} armFrom
 * @param {number} now
 */
export function questionSendArmed(armFrom, now) {
  return armFrom !== null && now - armFrom >= APPROVAL_ARM_MS
}

/** @returns {QuestionDraft} */
export function emptyQuestionDraft() {
  return { labels: [], isOther: false, other: '', note: '' }
}

/**
 * A question's draft after one option (`label`, or null for Other) was
 * turned on or off. Single-select: the choice replaces the last one.
 * Multi-select: options add up; Other stands alone (the answer is either
 * labels or Other text), so choosing it clears the options and an option
 * clears Other. The Other text and the note are kept.
 * @param {boolean} multiSelect
 * @param {QuestionDraft} draft
 * @param {string | null} label
 * @param {boolean} isOn
 * @returns {QuestionDraft}
 */
export function chooseOption(multiSelect, draft, label, isOn) {
  if (label === null) return { ...draft, isOther: isOn, labels: isOn ? [] : draft.labels }
  if (!multiSelect) return isOn ? { ...draft, labels: [label], isOther: false } : { ...draft, labels: draft.labels.filter(l => l !== label) }
  const rest = draft.labels.filter(l => l !== label)
  return { ...draft, labels: isOn ? [...rest, label] : rest, isOther: isOn ? false : draft.isOther }
}

/**
 * @typedef {object} AskedQuestion
 * @property {string} question
 * @property {string} header
 * @property {boolean} multiSelect
 */

/**
 * The answer the page posts for `drafts` (keyed by question text):
 * `{ answers, notes? }` with `{ other }` for Other (as typed; the server
 * trims and checks it), `{ labels }` for ticked options, nothing for an
 * unanswered question; notes trimmed, blank ones left out.
 * @param {readonly AskedQuestion[]} questions
 * @param {Readonly<Record<string, QuestionDraft>>} drafts
 * @returns {{ answers: Record<string, { labels: string[] } | { other: string }>, notes?: Record<string, string> }}
 */
export function questionPost(questions, drafts) {
  /** @type {[string, { labels: string[] } | { other: string }][]} */
  const answers = []
  /** @type {[string, string][]} */
  const notes = []
  for (const q of questions) {
    const d = Object.hasOwn(drafts, q.question) ? drafts[q.question] : undefined
    if (!d) continue
    if (d.isOther) answers.push([q.question, { other: d.other }])
    else if (d.labels.length > 0) answers.push([q.question, { labels: [...d.labels] }])
    const note = d.note.trim()
    if (note) notes.push([q.question, note])
  }
  return notes.length ? { answers: Object.fromEntries(answers), notes: Object.fromEntries(notes) } : { answers: Object.fromEntries(answers) }
}

/**
 * What still stops the answers going, in plain words, before the server's
 * own rules are asked: "Still to answer: Colour, Fruit." for questions with
 * nothing chosen, or "Type your Other answer for Colour." for an empty
 * Other; null when nothing obvious is missing.
 * @param {readonly AskedQuestion[]} questions
 * @param {Readonly<Record<string, QuestionDraft>>} drafts
 * @returns {string | null}
 */
export function questionHint(questions, drafts) {
  const open = questions.filter(q => {
    const d = drafts[q.question]
    return !d || (!d.isOther && d.labels.length === 0)
  })
  if (open.length) return `Still to answer: ${open.map(questionName).join(', ')}.`
  const blank = questions.find(q => drafts[q.question]?.isOther && !drafts[q.question]?.other.trim())
  return blank ? `Type your Other answer for ${questionName(blank)}.` : null
}

/**
 * @param {AskedQuestion} q
 * @returns {string} a question's short name: its header, else its text cut to 40 characters
 */
export function questionName(q) {
  return q.header.trim() || (q.question.length > 40 ? `${q.question.slice(0, 39).trimEnd()}…` : q.question)
}

/**
 * Whether each question has an answer to send: an option ticked, or Other
 * chosen with some text.
 * @param {readonly AskedQuestion[]} questions
 * @param {Readonly<Record<string, QuestionDraft>>} drafts
 * @returns {boolean[]}
 */
export function answeredQuestions(questions, drafts) {
  return questions.map(q => {
    const d = Object.hasOwn(drafts, q.question) ? drafts[q.question] : undefined
    return Boolean(d && (d.isOther ? d.other.trim() : d.labels.length > 0))
  })
}

/**
 * The tab to show after an option was chosen on tab `index`: the next one
 * (after the last question, the Submit tab at `count`) for a single-select
 * question when an option, not Other, was turned on; else stay (null), since
 * multi-select collects several and Other needs typing.
 * @param {number} index
 * @param {number} count the number of questions
 * @param {boolean} multiSelect
 * @param {string | null} label the option, or null for Other
 * @param {boolean} isOn
 * @returns {number | null}
 */
export function tabAfterChoice(index, count, multiSelect, label, isOn) {
  if (multiSelect || label === null || !isOn) return null
  return Math.min(index + 1, count)
}

/**
 * The Submit tab's review, one row per question: its name, the answer as
 * Claude will read it (labels in offered order joined with ", ", or
 * "Other: <text>"), the note, and whether it is answered.
 * @param {readonly (AskedQuestion & { options: readonly { label: string }[] })[]} questions
 * @param {Readonly<Record<string, QuestionDraft>>} drafts
 * @returns {{ index: number, name: string, answer: string | null, note: string | null, isAnswered: boolean }[]}
 */
export function questionReview(questions, drafts) {
  const answered = answeredQuestions(questions, drafts)
  return questions.map((q, index) => {
    const d = Object.hasOwn(drafts, q.question) ? drafts[q.question] : undefined
    const labels = d ? q.options.map(o => o.label).filter(l => d.labels.includes(l)) : []
    const answer = !answered[index] || !d ? null : d.isOther ? `Other: ${d.other.trim()}` : labels.join(', ')
    const note = d?.note.trim() || null
    return { index, name: questionName(q), answer, note, isAnswered: Boolean(answered[index]) }
  })
}

export const FIELD_GONE_HOLD_MS = 3_000

/**
 * What a redraw does with a text field (composer, question card) whose
 * session or request can no longer take input: a focused one stays in place,
 * disabled (`frozen`), until focus leaves it, so the keys still being typed
 * never fall through to the page's shortcuts.
 * @param {boolean} hasFocus
 * @param {boolean} isUsable
 * @returns {'live' | 'frozen' | 'gone'}
 */
export function fieldFate(hasFocus, isUsable) {
  if (isUsable) return 'live'
  return hasFocus ? 'frozen' : 'gone'
}

/**
 * @typedef {object} Stamps what the window last loaded, as the server stamps it
 * @property {number} snapshot the `seq` of the snapshot on screen
 * @property {string} [bootId] the server process that made it; another one means everything changed (E-17)
 * @property {number} [seq]
 * @property {number} [checkedAt]
 * @property {number} prefs
 * @property {number} prs
 * @property {string | null} approvals
 */

/**
 * What a failed reply poll means. The request may still be delivered, so an
 * error keeps the watch going until the reply's deadline; a 404 (the server
 * no longer knows it) or the deadline leaves it `unknown`, which is never
 * offered as safe to send again.
 * @param {number} errorStatus HTTP status, 0 for a network error
 * @param {number} now
 * @param {number} deadline `replyDeadline(createdAt)`
 * @returns {'retry' | 'unknown'}
 */
export function pollErrorStep(errorStatus, now, deadline) {
  return errorStatus === 404 || now >= deadline ? 'unknown' : 'retry'
}

/**
 * Whether a live answer asked `from` a row offset can still be joined to the
 * rows held: only when they are not detached and still end at that offset.
 * An older page that came back meanwhile and cut the newest rows would
 * otherwise leave a hole between them and the answer.
 * @param {readonly ConversationRow[] | null} rows
 * @param {boolean} isDetached
 * @param {number} from
 */
export function liveAnswerFits(rows, isDetached, from) {
  return Boolean(rows) && !isDetached && liveFrom(/** @type {readonly ConversationRow[]} */ (rows)) === from
}

/** @param {string} text a short, stable hash of `text` (FNV-1a, 32 bit) */
function textHash(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

/**
 * The rows without the question Orbit's card is showing: while it is open the
 * card stands in for its row, as Claude desktop shows only the card, and once
 * it is answered the row comes back with the answer. Only the last unanswered
 * question row whose text starts with `question` is dropped.
 * @template {{ who: string, text: string, answered?: true }} R
 * @param {readonly R[]} rows
 * @param {string | null} question the open card's first question, or null
 * @returns {readonly R[]}
 */
export function withoutOpenQuestion(rows, question) {
  const squash = (/** @type {string} */ t) => t.replace(/\s+/g, ' ').trim()
  const head = question ? squash(question).slice(0, 80) : ''
  if (!head) return rows
  const at = rows.findLastIndex(r => r.who === 'question' && !r.answered)
  if (at < 0 || !squash(rows[at]?.text ?? '').startsWith(head)) return rows
  return rows.filter((_, i) => i !== at)
}

/**
 * The rows in drawing order: each next-step box moves after the rest of its
 * turn (the Claude text and tool runs before the next prompt, event or
 * question), as Claude desktop draws it below the closing message even
 * though the agent fills it first. The rows themselves are not changed.
 * @template {{ who: string, next?: true }} R
 * @param {readonly R[]} rows
 * @returns {R[]}
 */
export function nextStepLast(rows) {
  /** @type {R[]} */
  const out = []
  /** @type {R[]} */
  let held = []
  for (const r of rows) {
    if (r.next) {
      held.push(r)
      continue
    }
    if (held.length && r.who !== 'claude' && r.who !== 'tools' && r.who !== 'plan') {
      out.push(...held)
      held = []
    }
    out.push(r)
  }
  out.push(...held)
  return out
}

/**
 * A chat row's place in the transcript: its line offset and place on the
 * line, or its index when it has no offset.
 * @param {ConversationRow} r
 * @param {number} index
 */
export function chatRowId(r, index) {
  return `${r.o ?? `n${index}`}:${r.i ?? 0}`
}

/**
 * The cache key of a chat row's node: a node is reused only while the row
 * reads the same (its text, not just its length) and keeps its marks.
 * @param {ConversationRow} r
 * @param {number} index
 * @param {{ head: boolean, turn: boolean }} mark
 */
export function rowCacheKey(r, index, mark) {
  return `${chatRowId(r, index)}|${r.who}|${r.text.length}:${textHash(r.text)}|${r.cut ? 1 : 0}|${r.at}|${mark.head ? 1 : 0}${mark.turn ? 1 : 0}`
}

/**
 * Drops entries of a per-id Map or Set whose id is no longer live.
 * @param {Map<string, unknown> | Set<string>} collection
 * @param {(id: string) => boolean} isLive
 */
export function pruneById(collection, isLive) {
  for (const id of [...collection.keys()]) if (!isLive(id)) collection.delete(id)
}

/**
 * What a redraw does with a question card whose request ended: kept in place,
 * frozen, only when it still has focus and this window did not answer it
 * (its own answer shows its outcome instead).
 * @param {{ hasFocus: boolean, isAnsweredHere: boolean }} c
 * @returns {'freeze' | 'replace'}
 */
export function endedCardFate(c) {
  return c.hasFocus && !c.isAnsweredHere ? 'freeze' : 'replace'
}

/** The line on a frozen question card, from how its request ended. @param {string | undefined} outcome */
export function endedCardNote(outcome) {
  if (outcome === 'expired') return 'This question expired. Answer it in Claude.'
  if (outcome === 'ask') return 'Sent to Claude: answer it there.'
  if (outcome === 'dismiss') return 'Dismissed with your message.'
  return outcome ? 'Answered elsewhere.' : 'This question ended.'
}

/**
 * The body of an attention post: only once the window has its id from the
 * latest `hello` (a post without one would count as a shared legacy window
 * that never ends), and never a repeat of "not attentive" for the same id.
 * @param {boolean} attentive
 * @param {string | null} windowId
 * @param {{ attentive: boolean, windowId: string, selected?: string | null, focused?: boolean } | null} last the last body posted
 * @param {string | null} [selected] the session key this window has open (E-110), so the server follows its transcript
 * @param {boolean} [focused] the window has keyboard focus (E-116); omitted, the server treats it as unknown
 * @returns {{ attentive: boolean, windowId: string, selected: string | null, focused?: boolean } | null}
 */
export function attentionPost(attentive, windowId, last, selected = null, focused) {
  if (!windowId || !/^[0-9a-f]{16}$/.test(windowId)) return null
  if (!attentive && last?.windowId === windowId && last.attentive === false && (last.selected ?? null) === selected && last.focused === focused) return null
  return focused === undefined ? { attentive, windowId, selected } : { attentive, windowId, selected, focused }
}

/**
 * The New session model menu from `/api/launch/options`: its well-formed
 * entries, else `fallback` when the route failed or sent none.
 * @param {unknown} answer
 * @param {{ value: string, label: string }[]} fallback
 * @returns {{ value: string, label: string }[]}
 */
export function modelOptions(answer, fallback) {
  const models = answer && typeof answer === 'object' ? /** @type {{ models?: unknown }} */ (answer).models : null
  if (!Array.isArray(models)) return fallback
  const ok = models.filter(o => o && typeof o.value === 'string' && typeof o.label === 'string' && o.value.length <= 100 && o.label.length <= 100).map(o => ({ value: o.value, label: o.label }))
  return ok.length ? ok : fallback
}

export const RECONNECT_GRACE_MS = 3_000
export const SERVER_GONE_MS = 20_000
export const DATA_OLD_MS = 120_000
export const LOAD_FAILURES_SHOWN = 3

/**
 * @typedef {object} ShellInput what the window knows about its link to Orbit
 * @property {number} now
 * @property {boolean} connected the event stream is open
 * @property {number | null} droppedAt when the stream last dropped, null while open
 * @property {boolean} isClosed the token was refused or the stream closed for good
 * @property {number | null} retriedAt when the person last pressed Retry
 * @property {boolean} hasSnapshot a snapshot is on screen
 * @property {string | null} problem why the last snapshot was refused (`snapshotProblem`)
 * @property {number | null} acceptedAt when this window last applied a snapshot
 * @property {number | null} generatedAt when the snapshot on screen was made
 * @property {number | null} checkedAt when the server last confirmed the data current (its `checkedAt` stamp)
 * @property {boolean} isLoading no answer has arrived yet
 * @property {number} loadFailures failed loads in a row
 * @property {boolean} isPaused live updates are paused in the shared settings
 * @property {{ isWatching: boolean, isPaused: boolean, errors: string[] } | null} [health] the server's aggregator from `/api/health`, null until it answers
 */

/**
 * @typedef {object} ShellState the one banner the window shows about itself
 * @property {'ok' | 'expired' | 'server-gone' | 'reconnecting' | 'loading' | 'load-failed' | 'no-data' | 'rejected' | 'paused' | 'stale' | 'not-live' | 'partial'} kind
 * @property {string} text
 * @property {'retry' | 'new-desktop' | 'resume' | null} action
 * @property {boolean} blocksSending
 * @property {boolean} isAlert
 */

/**
 * @param {ShellState['kind']} kind
 * @param {string} text
 * @param {ShellState['action']} action
 * @param {boolean} [blocksSending]
 * @param {boolean} [isAlert]
 * @returns {ShellState}
 */
function shell(kind, text, action, blocksSending = false, isAlert = false) {
  return { kind, text, action, blocksSending, isAlert }
}


/**
 * The window's own state, most serious first. The data's age is how long
 * since something last confirmed it current, not since it last changed (an
 * idle machine changes nothing for minutes), and that age alone decides
 * whether sending pauses.
 * @param {ShellInput} c
 * @returns {ShellState}
 */
export function shellState(c) {
  const downFor = c.connected || c.droppedAt === null ? 0 : c.now - c.droppedAt
  if (c.isClosed) return shell('expired', 'Orbit restarted, so this window’s link expired. Use Pop out in the Orbit pane to open a new one.', null, true, true)
  if (downFor >= SERVER_GONE_MS) {
    const tried = c.retriedAt ? ` Last tried ${clockTime(c.retriedAt).slice(11)}.` : ''
    return shell('server-gone', `Can’t reach Orbit. If it restarted, use Pop out in the Orbit pane.${tried}`, 'retry', true, true)
  }
  if (downFor >= RECONNECT_GRACE_MS) return shell('reconnecting', 'Reconnecting to Orbit…', 'retry', true)
  if (!c.hasSnapshot && c.isLoading) return c.loadFailures >= LOAD_FAILURES_SHOWN ? shell('load-failed', 'Can’t load sessions from Orbit.', 'retry') : shell('loading', 'Loading sessions…', null)
  if (!c.hasSnapshot) return shell('no-data', 'No sessions yet: start a Claude desktop session with Orbit.', 'new-desktop')
  if (c.problem) return shell('rejected', c.problem, 'retry', c.acceptedAt !== null && c.now - c.acceptedAt >= DATA_OLD_MS)
  const age = c.now - Math.max(c.checkedAt ?? 0, c.generatedAt ?? 0)
  const isOld = age >= DATA_OLD_MS
  if (c.isPaused || c.health?.isPaused) return shell('paused', `Live updates are paused.${isOld ? ` This data is ${duration(age)} old.` : ''}`, 'resume', isOld)
  if (isOld) return shell('stale', `Not updated for ${duration(age)}: Orbit stopped checking for changes.`, 'retry', true)
  if (c.health && !c.health.isWatching) return shell('not-live', 'Not live: Orbit is not watching the session files.', 'retry')
  const failed = c.health?.errors.filter(e => e.startsWith('aggregation failed')) ?? []
  if (failed.length > 0) return shell('not-live', `Not live: ${failed.join(', ')}.`, 'retry')
  if (c.health && c.health.errors.length > 0) return shell('partial', `Live, but ${c.health.errors.join(', ')}.`, null)
  return shell('ok', '', null)
}

/**
 * The remote-control capabilities that are on, in a fixed order, for the
 * Settings button's dot and name and the pane's indicator.
 * @param {{ approvals: boolean, questions: boolean, replies: boolean }} c
 * @returns {{ key: string, label: string, control: string, title: string }[]}
 */
export function armedCapabilities(c) {
  return [
    c.approvals ? { key: 'approvals', label: 'Approvals', control: 's-arm-approvals', title: 'Permission prompts wait in Orbit first while you use a window. Opens the switch.' } : null,
    c.questions ? { key: 'questions', label: 'Questions', control: 's-arm-questions', title: 'Questions from sessions wait in Orbit first while you use a window. Opens the switch.' } : null,
    c.replies ? { key: 'replies', label: 'Replies as me', control: 's-arm-replies', title: 'Orbit can send replies into sessions as you. Opens the switch.' } : null,
  ].filter(x => x !== null)
}

/** The pane's lead before the armed capabilities (A5 item 2). */
export const ARMED_LEAD = 'Remote control on, all windows:'

/**
 * The header Settings button's name, "Settings · Remote control on: Approvals,
 * Questions" while anything is armed, else "Settings" (A5: armed is visible in
 * every view).
 * @param {{ label: string }[]} armed from `armedCapabilities`
 */
export function settingsName(armed) {
  return armed.length ? `Settings · Remote control on: ${armed.map(c => c.label).join(', ')}` : 'Settings'
}

const HOOK_QUIET_MS = 7 * 86_400_000

/**
 * What a capability still needs before it can work (E-25), or null.
 * @param {'approvals' | 'questions' | 'replies'} capability
 * @param {{ hookSeenAt: number | null, replySessions: number, olderSessions: number }} setup from `GET /api/arm`
 * @param {number} now
 * @returns {string | null}
 */
export function armSetupLine(capability, setup, now) {
  if (capability === 'replies') {
    const can = `${setup.replySessions} ${setup.replySessions === 1 ? 'session' : 'sessions'} can take replies`
    return setup.olderSessions > 0 ? `${can}; ${setup.olderSessions} ${setup.olderSessions === 1 ? 'runs' : 'run'} an older Orbit.` : `${can}.`
  }
  if (setup.hookSeenAt === null || now - setup.hookSeenAt > HOOK_QUIET_MS) return 'The approval hook has not called in yet: install it to use this.'
  return null
}

/**
 * The line for a reply the server refused before queueing it, or null for any other failure.
 * @param {number | undefined} status
 * @param {{ reason?: unknown, older?: unknown, [key: string]: unknown } | null | undefined} detail
 * @returns {{ text: string, isNotArmed: boolean } | null}
 */
export function replyRefusal(status, detail) {
  if (status !== 409) return null
  if (detail?.reason === 'not-armed') return { text: 'Not sent: replies are off. Turn on Replies as me in Settings.', isNotArmed: true }
  if (detail?.older) return { text: REPLY_OLDER_TEXT, isNotArmed: false }
  return null
}

export const TYPING_EVERY_MS = 10_000

/** Whether to tell the server again that a question's answer is being typed (E-23). @param {number | null} lastAt @param {number} now */
export function isTypingDue(lastAt, now) {
  return lastAt === null || now - lastAt >= TYPING_EVERY_MS
}

/**
 * An alert from `GET /api/alerts` in one plain line (E-22).
 * @param {{ kind: string, where: string, what: string, at: number }} alert
 * @returns {string}
 */
export function alertText(alert) {
  if (alert.where === 'window') return 'This window’s link was used somewhere else, so Orbit locked it: open Pop out again.'
  if (alert.where === 'arm') return 'The arm settings failed their check, so every switch is off. Turn back on what you want in Settings.'
  return `Orbit deleted a file in its ${alert.where} folder that it did not write; nothing was ${alert.where === 'approvals' ? 'approved or sent' : 'sent'}.`
}

const CAPABILITY_NAME = { approvals: 'Approvals', questions: 'Questions', replies: 'Replies as me' }

/**
 * An `audit.jsonl` entry as one line: kind, subject, outcome.
 * @param {{ kind: string, capability?: string, armed?: boolean, tool?: string, outcome?: string, where?: string, what?: string, at: number, [key: string]: unknown }} e
 * @returns {string}
 */
export function auditText(e) {
  if (e.kind === 'arm') {
    const name = CAPABILITY_NAME[/** @type {keyof typeof CAPABILITY_NAME} */ (e.capability)] ?? e.capability
    return [`${name} turned ${e.armed ? 'on' : 'off'}`, e.outcome].filter(Boolean).join(' · ')
  }
  if (e.kind === 'alert') return ['Alert', e.where, e.what].filter(Boolean).join(' · ')
  const label = e.kind === 'approval' ? 'Approval' : e.kind === 'question' ? 'Question' : e.kind === 'reply' ? 'Reply' : e.kind
  return [label, e.tool, e.outcome].filter(Boolean).join(' · ')
}

/** @type {Partial<Record<ShellState['kind'], string>>} */
const SEND_PAUSED = {
  expired: 'Sending paused: Orbit is not reachable.',
  'server-gone': 'Sending paused: Orbit is not reachable.',
  reconnecting: 'Sending paused: reconnecting to Orbit.',
}

/**
 * The composer's line while the window's own state blocks sending, or null.
 * @param {ShellState} shell
 * @returns {{ short: string, text: string } | null}
 */
export function shellSendBlock(shell) {
  if (!shell.blocksSending) return null
  return { short: SEND_PAUSED[shell.kind] ?? 'Sending paused: this data is out of date.', text: shell.text }
}

/**
 * @typedef {object} SessionStatus D-4: one of five buckets, with one reason line (schema 2)
 * @property {'needs-you' | 'working' | 'review' | 'idle' | 'failed'} bucket
 * @property {string} reason
 * @property {number | null} since
 * @property {boolean} [isObserved]
 */

/**
 * A session's D-4 status, or idle for a session without one (schema 1).
 * @param {SessionView} s
 * @returns {SessionStatus}
 */
export function statusOf(s) {
  const st = /** @type {{ status?: SessionStatus }} */ (/** @type {unknown} */ (s)).status
  return st && typeof st.bucket === 'string' ? st : { bucket: 'idle', reason: '', since: null }
}

/** @type {{ key: SessionStatus['bucket'], label: string, order: (a: SessionView, b: SessionView) => number }[]} */
const QUEUE = [
  { key: 'needs-you', label: 'Needs you', order: (a, b) => (statusOf(a).since ?? 0) - (statusOf(b).since ?? 0) },
  { key: 'failed', label: 'Failed', order: (a, b) => (statusOf(b).since ?? 0) - (statusOf(a).since ?? 0) },
  { key: 'review', label: 'Ready for review', order: (a, b) => (statusOf(b).since ?? 0) - (statusOf(a).since ?? 0) },
  { key: 'working', label: 'Working', order: (a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) },
  { key: 'idle', label: 'Idle', order: (a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) },
]

/**
 * The queue rail: sessions grouped by their D-4 bucket, Needs you first
 * (longest waiting first), then Failed, Ready for review, Working, Idle;
 * empty groups are left out.
 * @param {readonly SessionView[]} sessions
 * @param {number} now
 * @returns {{ key: SessionStatus['bucket'], label: string, rows: SessionView[] }[]}
 */
export function queueGroups(sessions, now) {
  void now
  return QUEUE.map(g => ({ key: g.key, label: g.label, rows: sessions.filter(s => statusOf(s).bucket === g.key).sort(g.order) })).filter(g => g.rows.length > 0)
}

/**
 * Whether the map may take its first fit now: only before it has a camera,
 * and only once the stage has a size (a hidden or minimised window lays out
 * at 0 by 0, and a fit to that is a view thousands of times too wide).
 * @param {object | null} camera
 * @param {{ width: number, height: number }} box
 */
export function canFirstFit(camera, box) {
  return !camera && box.width > 0 && box.height > 0
}

/**
 * A key pressed in a small menu (the panel's Snooze menu): the item to focus
 * next, wrapping, or that the menu closes (Esc returns focus to its button;
 * Tab lets focus move on).
 * @param {string} key
 * @param {number} index
 * @param {number} count
 * @returns {{ index: number } | { close: true, refocus: boolean } | null}
 */
export function menuStep(key, index, count) {
  if (key === 'ArrowDown') return { index: (index + 1) % count }
  if (key === 'ArrowUp') return { index: (index - 1 + count) % count }
  if (key === 'Home') return { index: 0 }
  if (key === 'End') return { index: count - 1 }
  if (key === 'Escape') return { close: true, refocus: true }
  if (key === 'Tab') return { close: true, refocus: false }
  return null
}

/**
 * What a click (a press without a drag) on the map does: a session selects
 * it; a sub-agent opens its own panel (`'agent'`); a project puts the whole
 * project in focus (`'project'`, 2.1.8); empty map deselects and closes the
 * panel, as in 1.15; another node leaves things as they are.
 * @param {string | null} hitId the node under the pointer, if any
 * @returns {'select' | 'agent' | 'project' | 'deselect' | 'none'}
 */
export function mapClickAction(hitId) {
  if (!hitId) return 'deselect'
  if (hitId.startsWith('s:')) return 'select'
  if (hitId.startsWith('a:')) return 'agent'
  return hitId.startsWith('p:') ? 'project' : 'none'
}

/**
 * What Esc does on the page, after dialogs and menus have had it: a field in
 * the panel gives up focus, the search clears while it has focus, the queue
 * overlay closes; then the open panel closes, hiding any hover card with it,
 * so the panel never needs the cross; then a lone hover card, then a search
 * left behind, then a project in focus. In the Conversation view on a narrow
 * window, details shown over the conversation fold away before the session
 * closes.
 * @param {{ inPanelField: boolean, inSearch: boolean, hasQuery: boolean, railOpen: boolean, cardShown: boolean, panelOpen: boolean, projectFocused?: boolean, detailsShown?: boolean }} s
 * @returns {{ blurField?: true, clearSearch?: true, closeRail?: true, closeDetails?: true, closePanel?: true, hideCard?: boolean, clearFocus?: true }}
 */
export function escapeAction(s) {
  if (s.inPanelField) return { blurField: true }
  if (s.inSearch) return { clearSearch: true }
  if (s.railOpen) return { closeRail: true }
  if (s.detailsShown) return { closeDetails: true }
  if (s.panelOpen) return { closePanel: true, hideCard: s.cardShown }
  if (s.cardShown) return { hideCard: true }
  if (s.hasQuery) return { clearSearch: true }
  if (s.projectFocused) return { clearFocus: true }
  return {}
}

/**
 * The window's view: the map unless it chose the Conversation view (a window
 * that had chosen the old List view gets the Conversation view).
 * @param {unknown} stored
 * @returns {'map' | 'conversation'}
 */
export function viewOf(stored) {
  return stored === 'conversation' || stored === 'list' ? 'conversation' : 'map'
}

/**
 * What the Conversation view's centre shows while no session is open: a
 * heading with how many sessions need you, a line on what to do, the first
 * few that need you, and how many more there are.
 * @template {{ key: string }} T
 * @param {{ key: string, rows: T[] }[]} groups queueGroups' output
 * @param {number} [limit]
 * @returns {{ heading: string, note: string, top: T[], more: number }}
 */
export function convoHome(groups, limit = 5) {
  const needs = groups.find(g => g.key === 'needs-you')?.rows ?? []
  const total = groups.reduce((n, g) => n + g.rows.length, 0)
  if (needs.length > 0) return { heading: `${needs.length} ${needs.length === 1 ? 'session needs' : 'sessions need'} you`, note: 'Open one to read and answer it here.', top: needs.slice(0, limit), more: Math.max(0, needs.length - limit) }
  if (total > 0) return { heading: 'Nothing needs you', note: 'Pick a session on the left to open its conversation here.', top: [], more: 0 }
  return { heading: 'No sessions', note: 'Start one with New session (c).', top: [], more: 0 }
}

/** Left-column groups that start collapsed (1.15's column). */
export const GROUPS_CLOSED_BY_DEFAULT = ['working', 'idle']

/**
 * Whether a left-column group is open: the window's saved choice, else open
 * unless it starts collapsed. Every group is open while a search is on, so a
 * match is never hidden.
 * @param {string} key
 * @param {Record<string, unknown> | null | undefined} saved
 * @param {boolean} isSearching
 */
export function isGroupOpen(key, saved, isSearching) {
  if (isSearching) return true
  const choice = saved?.[key]
  return typeof choice === 'boolean' ? choice : !GROUPS_CLOSED_BY_DEFAULT.includes(key)
}

/**
 * The rows j, k and 1 to 9 step through: those of open groups, in queue order.
 * @param {readonly { key: string, rows: readonly { key: string }[] }[]} groups
 * @param {(key: string) => boolean} isOpen
 * @returns {string[]}
 */
export function openRowKeys(groups, isOpen) {
  return groups.filter(g => isOpen(g.key)).flatMap(g => g.rows.map(s => s.key))
}

/** @type {Record<string, string>} */
const BUCKET_WORD = { 'needs-you': 'Needs you', failed: 'Failed', review: 'Ready for review', working: 'Running', idle: 'Idle' }
const PLAIN_REASONS = new Set(['Needs you', 'Working', 'Idle', 'Running'])

/**
 * A left-column row's meta line, as 1.15 wrote it: the state word, its age,
 * then the reason ("Needs you 2h · run aws sso login"). A reason ending in
 * "since" takes the age itself ("Finished, not opened since 3m"). The line is
 * `before` + age + `after`, so the age can tick on its own.
 * @param {string} bucket
 * @param {string | null | undefined} reason
 * @returns {{ before: string, after: string }}
 */
export function rowMeta(bucket, reason) {
  const text = (reason ?? '').trim()
  if (/ since$/.test(text)) return { before: text, after: '' }
  const word = BUCKET_WORD[bucket] ?? 'Idle'
  return { before: word, after: text && !PLAIN_REASONS.has(text) && text !== word ? ` · ${text}` : '' }
}

/**
 * A row's meta line as one string, "Needs you 26m · Asked you a question":
 * `rowMeta` with the age between. The hover card says the status this way, so
 * it reads as the session's row does.
 * @param {{ bucket: string, reason?: string | null, since?: number | null }} st
 * @param {number} now
 */
export function statusLine(st, now) {
  const meta = rowMeta(st.bucket, st.reason)
  return `${meta.before}${st.since ? ` ${ago(now - st.since)}` : ''}${meta.after}`
}

/**
 * Whether the server's stamps say a new snapshot exists: its `seq` moved, or
 * the server restarted (`bootId`), which resets `seq`.
 * @param {{ seq?: number, bootId?: string, [key: string]: unknown } | null} prev
 * @param {{ seq?: number, bootId?: string, [key: string]: unknown }} next
 */
export function snapshotChanged(prev, next) {
  return !prev || prev.seq !== next.seq || prev.bootId !== next.bootId
}

/**
 * A schema 2 snapshot with the graph the map needs, computed by the shared
 * layout from the snapshot and the shared drag offsets (schema 2 carries none).
 * @template {{ projects: any[], worktrees: any[], sessions: any[], agents: any[] }} T
 * @param {T} snapshot
 * @param {Record<string, import('../types').Offset>} positions
 * @param {{ pack?: ReadonlySet<string> }} [options] passed to `layoutGraph` (2.1: the projects packed first)
 * @returns {T & { graph: { nodes: import('../types').GraphNode[], edges: import('../types').GraphEdge[] } }}
 */
export function withLayout(snapshot, positions, options = {}) {
  return { ...snapshot, graph: layoutGraph(snapshot, positions, options) }
}

/**
 * When the page lays the map out again: a new snapshot (`bootId`, `seq`), a
 * dragged node, or a change in which projects are packed first; never the
 * order of that set.
 * @param {{ bootId?: string, seq?: number }} stamp
 * @param {Record<string, unknown>} positions
 * @param {ReadonlySet<string>} pack
 */
export function layoutKeyOf(stamp, positions, pack) {
  return `${stamp.bootId}|${stamp.seq}|${JSON.stringify(positions)}|${[...pack].sort().join(',')}`
}

/**
 * The one key map (C6), shared by the page and, later, the pane: one
 * meaning per key. `shift` marks the shifted form; Ctrl, Alt and Meta never
 * reach it (the browser and the OS keep those).
 * @type {{ key: string, shift?: boolean, action: string, label: string }[]}
 */
export const KEY_MAP = [
  { key: 'n', action: 'next-needs-you', label: 'Next session that needs you' },
  { key: 'N', shift: true, action: 'previous-needs-you', label: 'Previous session that needs you' },
  { key: 'j', action: 'next', label: 'Next session in the queue' },
  { key: 'k', action: 'previous', label: 'Previous session in the queue' },
  { key: 'Enter', action: 'open-panel', label: 'Open the focused session' },
  { key: 'o', action: 'open-in-claude', label: 'Open the session in Claude' },
  { key: 'r', action: 'reply', label: 'Reply to the session' },
  { key: 'a', action: 'apply-skill', label: 'Apply a skill to the session' },
  { key: 'd', action: 'done', label: 'Mark done' },
  { key: 's', action: 'snooze-hour', label: 'Snooze for an hour' },
  { key: 'S', shift: true, action: 'snooze-tomorrow', label: 'Snooze until tomorrow 9:00' },
  { key: 'h', action: 'hide', label: 'Hide until it is active again' },
  { key: '/', action: 'search', label: 'Search sessions' },
  { key: 'Escape', action: 'back', label: 'Close the search, the queue or the conversation' },
  { key: 'ArrowLeft', action: 'move-left', label: 'Move to the session on the left' },
  { key: 'ArrowRight', action: 'move-right', label: 'Move to the session on the right' },
  { key: 'ArrowUp', action: 'move-up', label: 'Move to the session above' },
  { key: 'ArrowDown', action: 'move-down', label: 'Move to the session below' },
  { key: 'ArrowLeft', shift: true, action: 'pan-left', label: 'Pan the map left' },
  { key: 'ArrowRight', shift: true, action: 'pan-right', label: 'Pan the map right' },
  { key: 'ArrowUp', shift: true, action: 'pan-up', label: 'Pan the map up' },
  { key: 'ArrowDown', shift: true, action: 'pan-down', label: 'Pan the map down' },
  { key: '+', action: 'zoom-in', label: 'Zoom in' },
  { key: '=', action: 'zoom-in', label: 'Zoom in' },
  { key: '-', action: 'zoom-out', label: 'Zoom out' },
  { key: '0', action: 'fit', label: 'Fit all sessions' },
  { key: 'c', action: 'new-session', label: 'New session' },
  { key: 'u', action: 'undo', label: 'Undo the last Done, Snooze or Hide' },
  { key: 'l', action: 'view-conversation', label: 'Show the Conversation view' },
  { key: 'g', action: 'view-map', label: 'Show the map' },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ key: String(n), action: `open-${n}`, label: `Open the queue's item ${n}` })),
]

/**
 * The action a key press means, or null.
 * @param {{ key: string, shiftKey?: boolean, ctrlKey?: boolean, altKey?: boolean, metaKey?: boolean }} e
 * @returns {string | null}
 */
export function keyAction(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  const shift = Boolean(e.shiftKey)
  const isLetter = e.key.length === 1 && /[a-z]/i.test(e.key)
  const key = isLetter ? (shift ? e.key.toUpperCase() : e.key.toLowerCase()) : e.key
  const entry = KEY_MAP.find(k => k.key === key && Boolean(k.shift) === (isLetter ? shift && KEY_MAP.some(m => m.key === key && m.shift) : shift)) ?? (e.key.length === 1 ? KEY_MAP.find(k => k.key === key) : undefined)
  return entry?.action ?? null
}

/**
 * Whether a key types a character (a letter, digit or symbol): those
 * shortcuts work only while focus is on the map, the queue, the card or the
 * panel (WCAG 2.1.4), never page-wide.
 * @param {string} key
 */
export function isCharacterKey(key) {
  return key.length === 1
}

const SNOOZE_MORNING_HOUR = 9

/**
 * When a snooze ends: an hour from now, or 9:00 tomorrow (local time).
 * @param {'hour' | 'tomorrow'} kind
 * @param {number} now
 */
export function snoozeUntil(kind, now) {
  if (kind === 'hour') return now + 3_600_000
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(SNOOZE_MORNING_HOUR, 0, 0, 0)
  return d.getTime()
}

/** The prefs patch that marks a session done at `at`, or clears the mark (null). @param {string} key @param {number | null} at */
export function donePatch(key, at) {
  return { done: { [key]: at } }
}

/** The prefs patch that snoozes a session until `until` (set at `at`), or clears it (null). @param {string} key @param {number | null} until @param {number} at */
export function snoozePatch(key, until, at) {
  return { snoozed: { [key]: until === null ? null : { until, at } } }
}

const LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)|https?:\/\/[^\s<>"'`[\]]+/g
const TRAILING_PUNCTUATION = '.,;:!?\'"'

/** @param {string} url */
function trimUrlEnd(url) {
  let end = url.length
  for (;;) {
    const last = url[end - 1]
    if (last !== undefined && TRAILING_PUNCTUATION.includes(last)) end -= 1
    else if (last === ')' && (url.slice(0, end).match(/\(/g)?.length ?? 0) < (url.slice(0, end).match(/\)/g)?.length ?? 0)) end -= 1
    else return url.slice(0, end)
  }
}

/** @param {string} href */
function hostOf(href) {
  try {
    const url = new URL(href)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host ? url.host : null
  } catch {
    return null
  }
}

/**
 * Plain text split into text and link parts: `[label](url)` and bare URLs,
 * http and https only (anything else stays text), with trailing punctuation
 * and an unbalanced closing bracket left out of a bare URL. Each link carries
 * its host, which the page shows beside it.
 * @param {string} text
 * @returns {({ type: 'text', text: string } | { type: 'link', text: string, href: string, host: string })[]}
 */
export function linkParts(text) {
  /** @type {({ type: 'text', text: string } | { type: 'link', text: string, href: string, host: string })[]} */
  const out = []
  const pushText = (/** @type {string} */ t) => {
    if (!t) return
    const last = out.at(-1)
    if (last?.type === 'text') last.text += t
    else out.push({ type: 'text', text: t })
  }
  let at = 0
  for (const match of text.matchAll(LINK_PATTERN)) {
    const index = match.index ?? 0
    const isLabelled = match[1] !== undefined
    const href = isLabelled ? (match[2] ?? '') : trimUrlEnd(match[0])
    const host = hostOf(href)
    if (!host) continue
    pushText(text.slice(at, index))
    out.push({ type: 'link', text: isLabelled ? (match[1] ?? href) : href, href, host })
    at = index + (isLabelled ? match[0].length : href.length)
  }
  pushText(text.slice(at))
  return out
}

/**
 * The E-29 trace in words for a session's details: "3 errors, last 5m ago in
 * publish (EBUSY)"; null when there are none.
 * @param {{ count: number, lastAt: number, where: string, kind: string } | null | undefined} errors
 * @param {number} now
 */
export function errorsText(errors, now) {
  if (!errors || !(errors.count > 0)) return null
  return `${plural(errors.count, 'error')}, last ${since(now - errors.lastAt)} in ${errors.where} (${errors.kind})`
}

const ROW_LINE_MAX = 140

/**
 * The queue row's second line: what the session asks, unless its status
 * already says it, else its last report; whitespace folded, one line.
 * @param {{ lastReport?: { text?: string, ask?: string | null } | null }} s
 * @param {string} reason the status line the row already shows
 * @returns {string | null}
 */
export function rowSecondLine(s, reason) {
  const fold = (/** @type {string | null | undefined} */ t) => (t ?? '').replace(/\s+/g, ' ').trim()
  const ask = fold(s.lastReport?.ask)
  const text = ask && !reason.includes(ask) ? ask : fold(s.lastReport?.text)
  return text ? truncate(text, ROW_LINE_MAX) : null
}

/**
 * The Ctrl+K palette's rows. Page actions (New session, Settings…) match on
 * their own words; an action for one session (`verb` set, e.g. "Done") matches
 * only on its verb, never on the session's name, so typing a session's name
 * finds the session, not a triage action. With nothing typed: sessions, page
 * actions, then session actions; with a query: matching page actions, the
 * sessions (already matched by `switcherResults`), then matching session actions.
 * Skill actions (`search` set) appear only for a query, when every query word
 * starts a word of `search` (split on spaces, `/` and `:`), at most `PALETTE_SKILLS_MAX`, after the other session actions.
 * @template S
 * @template {{ id: string, label: string, verb?: string, search?: string }} A
 * @param {string} query
 * @param {readonly S[]} sessions
 * @param {readonly A[]} actions
 * @returns {({ kind: 'session', session: S } | { kind: 'action', action: A })[]}
 */
export function paletteResults(query, sessions, actions) {
  const q = query.trim().toLowerCase()
  const matches = (/** @type {string} */ text) => !q || text.toLowerCase().split(/\s+/).some(word => word.startsWith(q))
  const pageActions = actions.filter(a => !a.verb && matches(a.label)).map(action => ({ kind: /** @type {const} */ ('action'), action }))
  const sessionActions = actions.filter(a => a.verb && a.search === undefined && matches(a.verb)).map(action => ({ kind: /** @type {const} */ ('action'), action }))
  const queryWords = q.split(/[\s/:]+/).filter(Boolean)
  const skillHit = (/** @type {string} */ search) => {
    const words = search.split(/[\s/:]+/)
    return queryWords.every(w => words.some(word => word.startsWith(w)))
  }
  const skillActions = queryWords.length ? actions.filter(a => a.search !== undefined && skillHit(a.search)).slice(0, PALETTE_SKILLS_MAX).map(action => ({ kind: /** @type {const} */ ('action'), action })) : []
  const sessionRows = sessions.map(session => ({ kind: /** @type {const} */ ('session'), session }))
  return q ? [...pageActions, ...sessionRows, ...sessionActions, ...skillActions] : [...sessionRows, ...pageActions, ...sessionActions]
}

/** The most "Apply" skill rows the palette shows for one query. */
export const PALETTE_SKILLS_MAX = 8

/**
 * The header's limit meters from `limitsView`: the two fullest windows (one
 * when the header is compact) in their own order, the last carrying how many
 * more there are; each with a spoken name that leads with the window and its
 * level, then the reset and, for an old reading, its time.
 * @param {ReturnType<typeof import('./format.js').limitsView>} view
 * @param {boolean} compact
 */
export function headerMeters(view, compact) {
  if (!view) return []
  const keep = new Set([...view.parts].sort((a, b) => b.percent - a.percent).slice(0, compact ? 1 : 2))
  const shown = view.parts.filter(p => keep.has(p))
  const more = view.parts.length - shown.length
  const isStale = view.asOf !== null
  return shown.map((p, i) => {
    const extra = i === shown.length - 1 ? more : 0
    const level = p.level === 'critical' ? ', almost used up' : p.level === 'high' ? ', running high' : ''
    const name = `${p.long} limit, ${p.percent}% used${level}.${p.resets ? ` Resets ${p.resets}.` : ''}${isStale ? ` Reading from ${view.asOf}, may be out of date.` : ''}${extra ? ` ${extra} more in Settings.` : ''}`
    return { ...p, more: extra, isStale, name, title: `${p.text} used${p.resets ? `, resets ${p.resets}` : ''}${isStale ? ` (reading from ${view.asOf})` : ''}` }
  })
}

/**
 * Where focus goes when the row it was on leaves the queue (Done, Snooze,
 * Hide): the row after it, else the one before, else null (the map).
 * @param {readonly string[]} order the queue's keys before the change
 * @param {string} removedKey
 * @returns {string | null}
 */
export function nextFocusKey(order, removedKey) {
  const i = order.indexOf(removedKey)
  if (i < 0) return null
  return order[i + 1] ?? order[i - 1] ?? null
}

/**
 * Whether a key may act: character keys need focus in the map, queue, card
 * or panel (WCAG 2.1.4), except `u` while the toast offers an undo, which
 * works from anywhere so the undo it names always can be done.
 * @param {{ isCharacter: boolean, inScope: boolean, action: string, toastShown: boolean }} k
 */
export function keyInScope(k) {
  if (!k.isCharacter || k.inScope) return true
  return k.action === 'undo' && k.toastShown
}
