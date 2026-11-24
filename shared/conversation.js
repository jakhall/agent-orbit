// @ts-check

import { plural } from './format.js'
import { steeredText } from './inbox.js'
import { categorizeTool } from './redact.js'

/** @typedef {import('../types').ConversationRow} ConversationRow */
/** @typedef {import('../types').ToolCategory} ToolCategory */
/** @typedef {import('../types').TaskOp} TaskOp */
/** @typedef {{ o: number, text: string }} TranscriptLine one line of a transcript and the byte offset it starts at */

export const CONVERSATION_ROWS = 30
export const CONVERSATION_ROW_CHARS = 8000
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024
export const TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024
export const CONVERSATION_MIN_TURNS = 12

/** @type {Record<ToolCategory, string>} */
const PAST = {
  read: 'read',
  search: 'searched',
  edit: 'edited',
  test: 'ran tests',
  'git-write': 'ran',
  merge: 'ran',
  shell: 'ran',
  web: 'browsed',
  agent: 'delegated',
  question: '',
  plan: '',
  review: 'reviewed',
  skill: 'used',
  mcp: 'called',
  other: 'used',
}

const DROPPED_TAGS = [
  'system-reminder',
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'command-message',
  'command-args',
  'task-notification',
  'channel',
  'ide_selection',
  'ide_opened_file',
  'ide_diagnostics',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'user-prompt-submit-hook',
  'user-memory-input',
  'tools-used-before-summary',
  'fork-boilerplate',
  'artifact-view-context',
]
const TURN_NOTE = /^<(task-notification|channel)[\s>]/
const EVENT = /^<(side-sessions-event|ci-monitor-event|cross-session-message)(\s[^>]*)?>[\s\S]*<\/\1>$/
const EVENT_LABEL = {
  'side-sessions-event': 'Update from sessions you started',
  'ci-monitor-event': 'CI monitor update',
  'cross-session-message': 'Message from another session',
}
const COMMAND_OUTPUT = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g
const ARGS_MARK = '\uE000'
const WRAPPER = new RegExp(`<(${[...DROPPED_TAGS, 'pasted_content', 'command-name'].join('|')})(?:\\s[^>]*)?>([\\s\\S]*?)(?:</\\1>|$)`, 'g')

/**
 * @param {string} text
 * @returns {string}
 */
function cleanText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * @param {string} text
 * @returns {string}
 */
function promptText(text) {
  return text
    .replace(WRAPPER, (_match, /** @type {string} */ tag, /** @type {string} */ inner) => {
      if (tag === 'pasted_content') return '(pasted text)'
      if (tag === 'command-args') return `${ARGS_MARK}${cleanText(inner).slice(0, 300)}`
      const name = tag === 'command-name' ? /^\/?([\w:.-]{1,80})$/.exec(inner.trim()) : null
      return name ? `/${name[1]}` : ''
    })
    .replace(/(\/[\w:.-]{1,80})\s*\uE000/g, '$1 ')
    .replaceAll(ARGS_MARK, '')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

/**
 * What a slash command printed, when a user line is wholly its output
 * (`local-command-stdout`/`stderr`), else null; terminal colour codes removed.
 * @param {string} text
 * @returns {string | null}
 */
function commandOutput(text) {
  const parts = [...text.matchAll(COMMAND_OUTPUT)]
  if (parts.length === 0 || text.replace(COMMAND_OUTPUT, '').trim() !== '') return null
  return cleanText(parts.map(p => (p[2] ?? '').replace(ANSI, '')).join('\n'))
}

/**
 * The one-line label of a prompt that is wholly a message the app injected
 * (an event, not something you typed), else null.
 * @param {string} prompt
 * @returns {string | null}
 */
function eventLabel(prompt) {
  const match = EVENT.exec(prompt)
  if (!match) return null
  const tag = /** @type {keyof typeof EVENT_LABEL} */ (match[1])
  const from = tag === 'cross-session-message' ? /\sfrom-name="([^"]{1,200})"/.exec(match[2] ?? '') : null
  const name = from?.[1] ? cleanText(from[1]).replace(/\s+/g, ' ').slice(0, 60) : ''
  return name ? `Message from ${name}` : EVENT_LABEL[tag]
}

/**
 * @param {ToolCategory} category
 * @param {string} target
 * @returns {string}
 */
function phrase(category, target) {
  const safe = cleanText(target).replace(/\s+/g, ' ').slice(0, 60)
  if (category === 'test') return PAST.test
  const verb = PAST[category] ?? 'used'
  return verb ? `${verb} ${safe}`.trim() : safe
}

/**
 * One option of a question as a markdown list item; one marked
 * "(Recommended)" is drawn in bold with the mark after it.
 * @param {string} label
 * @returns {string}
 */
function optionItem(label) {
  const text = label.replace(/\s+/g, ' ').trim()
  const recommended = /^(.*\S)\s*\(recommended\)$/i.exec(text)
  return text ? `- ${recommended ? `**${recommended[1]}** (recommended)` : text}` : ''
}

/**
 * @param {Record<string, unknown>} input an AskUserQuestion tool input
 * @returns {string}
 */
function questionText(input) {
  const questions = Array.isArray(input.questions) ? input.questions.slice(0, 4) : []
  return questions
    .map(q => {
      const ask = typeof q?.question === 'string' ? cleanText(q.question).slice(0, 300) : ''
      const labels = Array.isArray(q?.options) ? q.options.slice(0, 6).map((/** @type {any} */ o) => (typeof o?.label === 'string' ? optionItem(cleanText(o.label).slice(0, 80)) : '')).filter(Boolean) : []
      return labels.length ? `${ask}\n${labels.join('\n')}` : ask
    })
    .filter(Boolean)
    .join('\n\n')
}

const NEXT_STEP_TOOL = 'mcp__ccd_turn__wrap_up'
const TASK_LIST_TOOL = 'mcp__ccd_turn__update_plan'
const TASK_STATUSES = ['pending', 'in_progress', 'completed']

/**
 * A desktop task-list call as a change to the list, or null when it says nothing usable.
 * @param {Record<string, unknown>} input a task-list tool input
 * @returns {TaskOp | null}
 */
function taskOp(input) {
  /** @type {TaskOp} */
  const op = {}
  if (Array.isArray(input.items)) {
    op.items = input.items
      .slice(0, 20)
      .filter((/** @type {any} */ s) => typeof s?.content === 'string' && TASK_STATUSES.includes(s.status))
      .map((/** @type {any} */ s) => ({ content: cleanText(s.content).replace(/\s+/g, ' ').trim().slice(0, 160), status: s.status }))
  }
  if (input.advance === true) op.advance = true
  if (Array.isArray(input.done)) op.done = input.done.filter(n => Number.isInteger(n)).slice(0, 20)
  if (Number.isInteger(input.start)) op.start = /** @type {number} */ (input.start)
  return Object.keys(op).length ? op : null
}
const HANDBACK_TOOL = 'SubagentHandback'

/**
 * The desktop's next-step box as a chat row: the recap and the question in
 * bold as text, its reply buttons as `choices` (the first is the desktop's
 * pick); app-action buttons (commit, merge) only work in Claude desktop and
 * are left out. Null when the box asks nothing, as the desktop then draws no box.
 * @param {Record<string, unknown>} input a next-step tool input
 * @returns {{ text: string, choices: string[] } | null}
 */
function nextStepRow(input) {
  const ask = typeof input.ask === 'string' ? cleanText(input.ask).replace(/\s+/g, ' ').slice(0, 300) : ''
  if (!ask) return null
  const recap = typeof input.recap === 'string' ? cleanText(input.recap).slice(0, 600) : ''
  const choices = Array.isArray(input.actions)
    ? input.actions.slice(0, 3).map((/** @type {any} */ a) => (typeof a?.label === 'string' && !a.action ? cleanText(a.label).replace(/\s+/g, ' ').trim().slice(0, 80) : '')).filter(Boolean)
    : []
  return { text: [recap, `**${ask}**`].filter(Boolean).join('\n\n'), choices }
}

/**
 * @param {{ phrases: string[], count: number }} run
 * @returns {string}
 */
function runText(run) {
  const shown = run.phrases.slice(0, 3)
  const more = run.phrases.length - shown.length
  const list = `${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}`
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} · ${plural(run.count, 'tool')}`
}

/**
 * @param {string} text
 * @returns {number} the UTF-8 length of `text` in bytes
 */
function utf8Length(text) {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

/**
 * The lines of transcript text with the byte offset each starts at, the
 * first one at `base`.
 * @param {string} text
 * @param {number} [base]
 * @returns {TranscriptLine[]}
 */
export function textLines(text, base = 0) {
  /** @type {TranscriptLine[]} */
  const lines = []
  let o = base
  for (const line of text.split('\n')) {
    lines.push({ o, text: line })
    o += utf8Length(line) + 1
  }
  return lines
}

/**
 * The whole lines of a transcript byte window read from offset `base`. When
 * `isLineStart` is false the window may begin inside a line, which is
 * dropped up to its first newline. `start` is the offset of the first line
 * kept; with none kept (the window is all one line) it is `base`, so a page
 * read back from it still moves past a line longer than the window.
 * @param {Uint8Array} bytes
 * @param {number} base
 * @param {boolean} isLineStart
 * @returns {{ lines: TranscriptLine[], start: number }}
 */
export function transcriptLines(bytes, base, isLineStart) {
  let pos = 0
  if (!isLineStart) {
    const newline = bytes.indexOf(10)
    if (newline < 0 || newline + 1 >= bytes.length) return { lines: [], start: base }
    pos = newline + 1
  }
  const start = base + pos
  const decoder = new TextDecoder()
  /** @type {TranscriptLine[]} */
  const lines = []
  while (pos < bytes.length) {
    const newline = bytes.indexOf(10, pos)
    const end = newline < 0 ? bytes.length : newline
    lines.push({ o: base + pos, text: decoder.decode(bytes.subarray(pos, end)) })
    pos = end + 1
  }
  return { lines, start }
}

/**
 * What the person said mid-turn, kept as a transcript attachment rather than
 * a user message: a prompt typed in Claude while Claude worked, or a reply
 * Orbit steered into the turn. Empty for every other attachment.
 * @param {any} attachment
 * @returns {string}
 */
function midTurnWords(attachment) {
  if (attachment?.type === 'queued_command' && attachment.origin?.kind === 'human' && typeof attachment.prompt === 'string') return promptText(attachment.prompt)
  if (attachment?.type === 'hook_additional_context' && Array.isArray(attachment.content)) {
    return attachment.content.map(steeredText).filter(/** @param {string | null} t */ t => t !== null).join('\n\n')
  }
  return ''
}

/**
 * @param {readonly TranscriptLine[]} lines
 * @returns {{ rows: ConversationRow[], turnOf: number[] }}
 */
/**
 * @param {readonly TranscriptLine[]} lines
 * @param {boolean} isSidechain
 */
function rowsOf(lines, isSidechain) {
  /** @type {ConversationRow[]} */
  const rows = []
  /** @type {number[]} */
  const turnOf = []
  let turn = 0
  /** @type {{ at: number | null, o: number, phrases: string[], count: number } | null} */
  let run = null
  /** @param {ConversationRow & { o: number }} row */
  const add = row => {
    const last = rows.at(-1)
    rows.push({ ...row, i: last && last.o === row.o ? (last.i ?? 0) + 1 : 0 })
    turnOf.push(turn)
  }
  const closeRun = () => {
    if (!run) return
    add({ who: 'tools', at: run.at, text: runText(run), o: run.o })
    run = null
  }
  const startTurn = () => {
    closeRun()
    turn += 1
  }
  /**
   * @param {'you' | 'claude'} who
   * @param {number | null} at
   * @param {number} o
   * @param {string} body
   */
  const say = (who, at, o, body) => {
    const t = cleanText(body)
    if (!t) return
    closeRun()
    const last = rows.at(-1)
    if (last && last.who === who && turnOf.at(-1) === turn) last.text = `${last.text}\n\n${t}`
    else add({ who, at, text: t, o })
  }
  for (const { o, text: line } of lines) {
    if (!line.trimStart().startsWith('{')) continue
    /** @type {any} */
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.type === 'attachment' && (isSidechain || entry.isSidechain !== true)) {
      const words = midTurnWords(entry.attachment)
      const stamped = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
      const t = cleanText(words)
      if (t) {
        closeRun()
        add({ who: 'you', at: Number.isFinite(stamped) ? stamped : null, text: t, o })
      }
      continue
    }
    if (!entry || typeof entry !== 'object' || (entry.type !== 'user' && entry.type !== 'assistant')) continue
    if ((!isSidechain && entry.isSidechain === true) || entry.isMeta === true || entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) continue
    const parsed = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    const at = Number.isFinite(parsed) ? parsed : null
    const content = entry.message?.content
    /** @type {any[]} */
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') {
        if (entry.type === 'user') {
          const output = commandOutput(block.text)
          if (output !== null) {
            if (output && output !== '(no content)') {
              closeRun()
              add({ who: 'claude', at, text: output, o })
            }
            continue
          }
          const prompt = promptText(block.text)
          const event = eventLabel(prompt)
          if (event) {
            startTurn()
            add({ who: 'event', at, text: event, o })
            continue
          }
          if (prompt || TURN_NOTE.test(block.text.trimStart())) startTurn()
          say('you', at, o, prompt)
        } else say('claude', at, o, block.text)
      } else if (block.type === 'tool_use' && entry.type === 'assistant') {
        const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {}
        const asked = block.name === 'AskUserQuestion' ? questionText(input) : ''
        if (asked) {
          closeRun()
          add({ who: 'question', at, text: asked, o })
          continue
        }
        if (block.name === HANDBACK_TOOL) {
          if (typeof input.message === 'string') say('claude', at, o, input.message)
          continue
        }
        if (block.name === TASK_LIST_TOOL || block.name === NEXT_STEP_TOOL) {
          const op = block.name === TASK_LIST_TOOL ? taskOp(input) : { finish: /** @type {const} */ (true) }
          if (op) add({ who: 'plan', at, text: '', o, plan: op })
        }
        if (block.name === TASK_LIST_TOOL) continue
        if (block.name === NEXT_STEP_TOOL) {
          const next = nextStepRow(input)
          if (next) {
            closeRun()
            add({ who: 'claude', at, text: next.text, o, ...(next.choices.length ? { choices: next.choices } : {}) })
          }
          continue
        }
        const { category, target } = categorizeTool(typeof block.name === 'string' ? block.name : 'tool', input)
        run ??= { at, o, phrases: [], count: 0 }
        run.count += 1
        const said = phrase(category, target)
        if (!run.phrases.includes(said)) run.phrases.push(said)
      }
    }
  }
  closeRun()
  return { rows, turnOf }
}

/**
 * @param {ConversationRow} row
 * @returns {ConversationRow}
 */
function capRow(row) {
  if (row.text.length <= CONVERSATION_ROW_CHARS) return { ...row }
  return { ...row, text: `${row.text.slice(0, CONVERSATION_ROW_CHARS - 1).trimEnd()}…`, cut: true }
}

/**
 * One page of a session's conversation from transcript lines: user prompts
 * and assistant text as rows, each run of tool calls as one redacted line
 * (category and safe target only), AskUserQuestion calls as a question
 * row (the question and its option labels, which are addressed to the user),
 * the desktop's next-step box as a Claude row when it asks something, each
 * desktop task-list call and next-step box as a hidden `plan` row (its change
 * to the task list, which does not end a run of tool calls), and a
 * sub-agent's report to its caller (`SubagentHandback`) as a Claude row.
 * Tool results, thinking, subagent and bookkeeping lines are dropped;
 * unparseable lines are skipped. A prompt that is wholly an event the app
 * injected (`side-sessions-event`, `ci-monitor-event`,
 * `cross-session-message`) becomes a one-line `event` row, never a prompt.
 * Every row carries `o`, the offset of its first line, and `i`, its place
 * among the rows that start on that line, and is capped at
 * `CONVERSATION_ROW_CHARS` (`cut` when it was).
 *
 * A page is only ever cut between lines. With `isCut` (the lines do not
 * start at the file start) the rows of the first line are dropped when the
 * first is a Claude or tool row (it may be the end of a longer one) and
 * other lines follow; with `limit` only about the last `limit` rows are kept,
 * widened to the start of their first line. `start` is where an older page
 * continues: the first kept row's offset when rows were dropped, else
 * `windowStart`.
 * @param {readonly TranscriptLine[]} lines
 * @param {number} windowStart the offset of the first line
 * With `isSidechain` the lines are a sub-agent's own transcript, where every
 * line is a sidechain line, so those are kept.
 * @param {{ isCut: boolean, limit: number | null, isSidechain?: boolean }} options
 * @returns {{ rows: ConversationRow[], turns: number, start: number }}
 */
export function pageRows(lines, windowStart, { isCut, limit, isSidechain = false }) {
  const built = rowsOf(lines, isSidechain)
  const all = built.rows
  let from = 0
  const first = all[0]
  if (isCut && first && (first.who === 'claude' || first.who === 'tools')) {
    const next = all.findIndex(r => r.o !== first.o)
    if (next > 0) from = next
  }
  if (limit !== null && all.length - from > limit) {
    let cut = all.length - limit
    while (cut > 0 && all[cut - 1]?.o === all[cut]?.o) cut -= 1
    from = Math.max(from, cut)
  }
  const rows = all.slice(from).map(capRow)
  const start = from > 0 ? (rows[0]?.o ?? windowStart) : windowStart
  return { rows, turns: new Set(built.turnOf.slice(from)).size, start }
}

/**
 * When the last conversation entry of transcript text was written: the
 * timestamp of the last `user` or `assistant` line (sidechains and tool
 * results count; meta and transcript-only lines do not), read from the end
 * and stopping at the first one found. The bookkeeping lines a CLI appends
 * when it exits (`last-prompt`, `cost-state`, system lines) are not
 * conversation, so they never move it. Null when no such line has a time.
 * @param {string} text
 * @returns {number | null}
 */
export function lastEntryAt(text) {
  let end = text.length
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    const line = text.slice(start, end)
    end = start - 1
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue
    /** @type {any} */
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || (entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta === true || entry.isVisibleInTranscriptOnly === true) continue
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    if (Number.isFinite(at)) return at
  }
  return null
}

/**
 * @typedef {object} ConversationPage
 * @property {ConversationRow[]} rows
 * @property {number} turns
 * @property {number} size the offset the rows were read up to
 * @property {number} start where an older page continues (`before=`)
 * @property {boolean} isStart the rows reach the start of the file
 * @property {true} [reset] a `from` window was too far back: this is the tail instead
 */

/**
 * One page of a transcript's conversation, read through `read(begin, end)`
 * (bytes of the file from `begin` up to `end`) so that no more than
 * `bytes.max` is ever read at once and never the whole file:
 * - `tail`: the end of the file, from `bytes.first` doubling while it holds
 *   fewer than `CONVERSATION_MIN_TURNS` turns and `CONVERSATION_ROWS` rows;
 * - `before`: rows from lines ending at or before `offset`, growing the same
 *   way until `CONVERSATION_ROWS` rows or the file start;
 * - `from`: every row from `offset` (a row's `o`) to the end; more than
 *   `bytes.max` back gives the tail with `reset`.
 * @param {(begin: number, end: number) => Uint8Array | Promise<Uint8Array>} read
 * @param {{ mode: 'tail' | 'before' | 'from', offset?: number, size: number }} request
 * @param {{ first: number, max: number }} [bytes]
 * @param {{ isSidechain?: boolean }} [options] a sub-agent's transcript
 * @returns {Promise<ConversationPage>}
 */
export async function readConversation(read, request, bytes = { first: TRANSCRIPT_TAIL_BYTES, max: TRANSCRIPT_MAX_BYTES }, { isSidechain = false } = {}) {
  const { mode, size } = request
  const offset = request.offset ?? size
  if (mode === 'from') {
    if (size - offset > bytes.max) return { ...(await readConversation(read, { mode: 'tail', size }, bytes, { isSidechain })), reset: true }
    const window = transcriptLines(await read(offset, size), offset, true)
    const page = pageRows(window.lines, offset, { isCut: false, limit: null, isSidechain })
    return { rows: page.rows, turns: page.turns, size, start: offset, isStart: offset === 0 }
  }
  const end = mode === 'tail' ? size : offset
  for (let chunk = bytes.first; ; chunk *= 2) {
    const begin = Math.max(0, end - chunk)
    const window = transcriptLines(await read(begin, end), begin, begin === 0)
    const page = pageRows(window.lines, window.start, { isCut: begin > 0, limit: CONVERSATION_ROWS, isSidechain })
    const isEnough = mode === 'tail' ? page.turns >= CONVERSATION_MIN_TURNS || page.rows.length >= CONVERSATION_ROWS : page.rows.length >= CONVERSATION_ROWS
    if (isEnough || begin === 0 || chunk >= bytes.max) return { rows: page.rows, turns: page.turns, size: end, start: page.start, isStart: page.start === 0 }
  }
}

/**
 * A transcript file's identity, so a page cursor never crosses to another
 * file under the same name: its file id and creation time.
 * @param {{ ino: number | bigint, birthtimeMs: number }} stat
 * @returns {string}
 */
export function fileIdOf(stat) {
  return `${stat.ino}-${stat.birthtimeMs}`
}

/**
 * A byte offset from a query string: a plain integer from 0 to 2^53, else
 * null.
 * @param {string | null} value
 * @returns {number | null}
 */
export function offsetParam(value) {
  if (value === null || !/^\d{1,16}$/.test(value) || (value.length === 16 && value > '9007199254740992')) return null
  return Number(value)
}

/**
 * The transcript file name (`<cliSessionId>.jsonl`) of a session the snapshot
 * lists, or null: an unknown key, no CLI session id, or an id that is not a
 * plain name. No part of a path ever comes from the request.
 * @param {{ sessions?: { key?: unknown, cliSessionId?: unknown }[] } | null | undefined} snapshot
 * @param {string} key
 * @returns {string | null}
 */
export function transcriptName(snapshot, key) {
  const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : []
  const session = sessions.find(s => s && s.key === key)
  const id = session?.cliSessionId
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id) ? `${id}.jsonl` : null
}
