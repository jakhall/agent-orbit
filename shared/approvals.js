// @ts-check

/** @typedef {import('../types').Snapshot} Snapshot */
/** @typedef {import('../types').ApprovalRequest} ApprovalRequest */
/** @typedef {import('../types').ApprovalView} ApprovalView */
/** @typedef {import('../types').ApprovalOutcome} ApprovalOutcome */
/** @typedef {import('../types').QuestionSpec} QuestionSpec */
/** @typedef {import('../types').QuestionChoice} QuestionChoice */
/** @typedef {import('../types').HookDecision} HookDecision */

export const APPROVAL_INPUT_CHARS = 16 * 1024
export const APPROVAL_WAIT_MS = 60_000
export const APPROVAL_POLL_MS = 200
/**
 * How long a question may stay open while someone types an answer (E-23),
 * from when it was asked: below the installed hook's 120 s timeout, after
 * which Claude ends the hook. A longer wait needs a higher hook timeout.
 */
export const QUESTION_WAIT_MAX_MS = 110_000
export const APPROVAL_ATTENTIVE_MS = 25_000
export const APPROVAL_IDLE_INPUT_MS = 60_000
export const APPROVAL_ARM_MS = 1_000
export const APPROVAL_UNMATCHED_GRACE_MS = 2_000
export const APPROVAL_OUTCOME_SHOWN_MS = 30_000
export const APPROVAL_BEHAVIORS = /** @type {const} */ (['allow', 'deny', 'ask'])
export const APPROVAL_DENY_MESSAGE = 'Denied from Orbit.'
export const QUESTION_TOOL = 'AskUserQuestion'
export const QUESTION_BEHAVIORS = /** @type {const} */ (['answer', 'ask', 'dismiss'])
export const QUESTION_LIMITS = Object.freeze({ questions: 4, question: 1_000, header: 40, minOptions: 2, maxOptions: 4, label: 200, description: 1_000, preview: 8_000, other: 2_000, notes: 2_000, input: 192 * 1024 })
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const HASH = /^[0-9a-f]{64}$/
const PERSON_ONLY = new Set(['ExitPlanMode', 'EnterPlanMode'])
const HIDDEN_CHAR = /[\p{Cc}\p{Cf}\u2028\u2029\u115F\u1160\u3164\uFFA0\u180E]/gu
const HAS_HIDDEN = new RegExp(HIDDEN_CHAR.source, 'u')
const LINE_CHARS = /\r\n|[\n\t]/g

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A string of at most `max` characters with no control, format, bidi or
 * zero-width characters; `allowLines` also lets line feeds, CRLF and tabs through.
 * @param {unknown} text
 * @param {number} max
 * @param {boolean} allowLines
 * @returns {text is string}
 */
function isCleanText(text, max, allowLines) {
  return typeof text === 'string' && text.length <= max && !HAS_HIDDEN.test(allowLines ? text.replace(LINE_CHARS, '') : text)
}

/**
 * Whether `id` is a request id Orbit could have made (`crypto.randomUUID()`).
 * @param {unknown} id
 * @returns {id is string}
 */
export function isApprovalId(id) {
  return typeof id === 'string' && UUID_V4.test(id)
}

/**
 * Tools only the person may answer (a plan to approve, the app's own cards):
 * the hook leaves them to Claude. `AskUserQuestion` is not one of them: it
 * becomes a question request.
 * @param {string} toolName
 * @returns {boolean}
 */
export function isPersonOnlyTool(toolName) {
  return PERSON_ONLY.has(toolName) || toolName.startsWith('mcp__ccd_')
}

/**
 * Whether a request (or view) is an `AskUserQuestion` question rather than a
 * tool call to allow or deny. Decided by the tool name, never by a stored `kind`.
 * @param {{ toolName: string }} request
 * @returns {boolean}
 */
export function isQuestionRequest(request) {
  return request.toolName === QUESTION_TOOL
}

/**
 * The questions of an `AskUserQuestion` input, or null when anything is
 * malformed or too large to answer from Orbit (the desktop then asks them):
 * 1–4 questions with distinct, non-empty text (≤ 1,000 chars, line breaks
 * and tabs allowed), a header (≤ 40), an optional boolean `multiSelect`, and
 * 2–4 options each with a distinct, non-empty one-line label (≤ 200), an
 * optional description (≤ 1,000) and preview (≤ 8,000). Question text, headers
 * and labels must hold no control, format, bidi or zero-width characters;
 * the whole input stays under `QUESTION_LIMITS.input` characters of canonical JSON.
 * @param {unknown} toolInput
 * @returns {QuestionSpec[] | null}
 */
export function readQuestions(toolInput) {
  const L = QUESTION_LIMITS
  if (!isPlainObject(toolInput)) return null
  const list = toolInput.questions
  if (!Array.isArray(list) || list.length < 1 || list.length > L.questions) return null
  if (canonicalJson(toolInput).length > L.input) return null
  /** @type {QuestionSpec[]} */
  const out = []
  const texts = new Set()
  for (const q of list) {
    if (!isPlainObject(q) || !isCleanText(q.question, L.question, true) || q.question.trim() === '' || texts.has(q.question)) return null
    if (!isCleanText(q.header, L.header, false)) return null
    if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') return null
    if (!Array.isArray(q.options) || q.options.length < L.minOptions || q.options.length > L.maxOptions) return null
    const labels = new Set()
    /** @type {QuestionSpec['options']} */
    const options = []
    for (const o of q.options) {
      if (!isPlainObject(o) || !isCleanText(o.label, L.label, false) || o.label.trim() === '' || labels.has(o.label)) return null
      if (o.description !== undefined && (typeof o.description !== 'string' || o.description.length > L.description)) return null
      if (o.preview !== undefined && (typeof o.preview !== 'string' || o.preview.length > L.preview)) return null
      labels.add(o.label)
      options.push({ label: o.label, description: o.description ?? '', ...(o.preview !== undefined ? { preview: o.preview } : {}) })
    }
    texts.add(q.question)
    out.push({ question: q.question, header: q.header, multiSelect: q.multiSelect === true, options })
  }
  return out
}

/**
 * Checks an answer to `questions` (from the page, or read back by the hook):
 * `answers` names every question asked and no other, each with either
 * `{ labels }` (offered labels only, no repeats; exactly one for a
 * single-select question, at least one for multi-select) or `{ other }`
 * (non-empty after trimming, ≤ 2,000 chars, no control or hidden characters);
 * optional `notes` per asked question (≤ 2,000 chars, line breaks allowed;
 * blank notes are dropped). On success: `chosen` (the normalised structured
 * answer the server stores, labels in offered order), `answers` (the text
 * Claude receives per question: labels joined with ", ", or the Other text)
 * and `notes`.
 * @param {readonly QuestionSpec[]} questions
 * @param {unknown} body
 * @returns {{ ok: true, chosen: Record<string, QuestionChoice>, answers: Record<string, string>, notes: Record<string, string> } | { ok: false, status: 400, error: string }}
 */
export function checkQuestionAnswer(questions, body) {
  const L = QUESTION_LIMITS
  /** @param {string} error */
  const bad = error => /** @type {const} */ ({ ok: false, status: 400, error })
  const b = /** @type {any} */ (body)
  const asked = /** @type {readonly QuestionSpec[]} */ (Array.isArray(questions) ? questions : [])
  if (asked.length === 0) return bad('This is not a question request.')
  if (!isPlainObject(b?.answers)) return bad('answers must be an object keyed by question.')
  if (b.notes !== undefined && !isPlainObject(b.notes)) return bad('notes must be an object keyed by question.')
  const askedTexts = new Set(asked.map(q => q.question))
  for (const key of [...Object.keys(b.answers), ...Object.keys(b.notes ?? {})]) if (!askedTexts.has(key)) return bad('An answer names a question that was not asked.')
  /** @type {[string, QuestionChoice][]} */
  const chosen = []
  /** @type {[string, string][]} */
  const answers = []
  /** @type {[string, string][]} */
  const notes = []
  for (const q of asked) {
    if (!Object.hasOwn(b.answers, q.question)) return bad('Every question needs an answer.')
    const a = b.answers[q.question]
    if (!isPlainObject(a) || Object.hasOwn(a, 'labels') === Object.hasOwn(a, 'other')) return bad('Each answer is either { labels } or { other }.')
    if (Object.hasOwn(a, 'labels')) {
      if (!Array.isArray(a.labels) || a.labels.some((/** @type {unknown} */ l) => typeof l !== 'string')) return bad('labels must be a list of option labels.')
      const offered = q.options.map(o => o.label)
      if (a.labels.some((/** @type {string} */ l) => !offered.includes(l))) return bad('An answer names an option that was not offered.')
      if (new Set(a.labels).size !== a.labels.length) return bad('An option is chosen twice.')
      if (q.multiSelect ? a.labels.length < 1 : a.labels.length !== 1) return bad(q.multiSelect ? 'Choose at least one option.' : 'Choose exactly one option.')
      const labels = offered.filter(l => a.labels.includes(l))
      chosen.push([q.question, { labels }])
      answers.push([q.question, labels.join(', ')])
    } else {
      const text = typeof a.other === 'string' ? a.other.trim() : ''
      if (!text) return bad('Other needs some text.')
      if (text.length > L.other) return bad('Other text is limited to 2,000 characters.')
      if (HAS_HIDDEN.test(text)) return bad('Other text cannot hold control or hidden characters.')
      chosen.push([q.question, { other: text }])
      answers.push([q.question, text])
    }
    if (b.notes && Object.hasOwn(b.notes, q.question)) {
      const note = b.notes[q.question]
      if (typeof note !== 'string') return bad('Notes must be text.')
      const text = note.trim()
      if (text.length > L.notes) return bad('Notes are limited to 2,000 characters.')
      if (!isCleanText(text, L.notes, true)) return bad('Notes cannot hold control or hidden characters.')
      if (text) notes.push([q.question, text])
    }
  }
  return { ok: true, chosen: Object.fromEntries(chosen), answers: Object.fromEntries(answers), notes: Object.fromEntries(notes) }
}

/**
 * JSON with object keys sorted at every level and no spacing, so the same
 * tool call always gives the same text (and hash).
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(v => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`
  const record = /** @type {Record<string, unknown>} */ (value)
  const keys = Object.keys(record)
    .filter(k => record[k] !== undefined)
    .sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`
}

/**
 * The text a request's `inputHash` is the SHA-256 of.
 * @param {string} toolName
 * @param {unknown} toolInput
 * @returns {string}
 */
export function hashText(toolName, toolInput) {
  return canonicalJson({ toolName, toolInput })
}

/**
 * Whether the page counts as watched: the window has focus, or saw pointer or
 * key input in the last minute.
 * @param {boolean} hasFocus
 * @param {number} lastInputAt
 * @param {number} now
 * @returns {boolean}
 */
export function isAttentive(hasFocus, lastInputAt, now) {
  return hasFocus || now - lastInputAt <= APPROVAL_IDLE_INPUT_MS
}

/**
 * Whether the snapshot lists a session with this CLI session id, so its
 * request can be shown somewhere.
 * @param {unknown} snapshot
 * @param {string} cliSessionId
 * @returns {boolean}
 */
export function isKnownSession(snapshot, cliSessionId) {
  const sessions = /** @type {any} */ (snapshot)?.sessions
  return Array.isArray(sessions) && sessions.some(s => s && s.cliSessionId === cliSessionId)
}

/**
 * The request file for one `PermissionRequest` hook input, or null when the
 * input is not one Orbit can show (no tool name, a person-only tool, no plain
 * session id, an `AskUserQuestion` that `readQuestions` refuses). Tool input
 * longer than `APPROVAL_INPUT_CHARS` is kept as cut text with
 * `truncated: true`, and such a request can never be allowed; a question
 * request (`kind: 'question'`) keeps its whole input and is never cut.
 * @param {unknown} input the hook's parsed stdin
 * @param {{ id: string, now: number, inputHash: string, hookPid: number, waitMs?: number, agentId?: string | null }} meta
 * @returns {ApprovalRequest | null}
 */
export function approvalRequest(input, meta) {
  const raw = /** @type {any} */ (input)
  if (!raw || typeof raw !== 'object' || typeof raw.tool_name !== 'string' || raw.tool_name === '' || raw.tool_name.length > 200 || isPersonOnlyTool(raw.tool_name)) return null
  if (typeof raw.session_id !== 'string' || !PLAIN_ID.test(raw.session_id) || !isApprovalId(meta.id) || !HASH.test(meta.inputHash) || !Number.isInteger(meta.hookPid)) return null
  const isQuestion = raw.tool_name === QUESTION_TOOL
  if (isQuestion && !readQuestions(raw.tool_input)) return null
  const full = canonicalJson(raw.tool_input ?? null)
  const truncated = !isQuestion && full.length > APPROVAL_INPUT_CHARS
  return {
    schema: 1,
    id: meta.id,
    kind: isQuestion ? 'question' : 'tool',
    createdAt: meta.now,
    expiresAt: meta.now + (meta.waitMs ?? APPROVAL_WAIT_MS),
    cliSessionId: raw.session_id,
    cwd: typeof raw.cwd === 'string' ? raw.cwd.slice(0, 1000) : null,
    toolName: raw.tool_name,
    toolInput: truncated ? full.slice(0, APPROVAL_INPUT_CHARS) : raw.tool_input ?? null,
    truncated,
    inputHash: meta.inputHash,
    permissionMode: typeof raw.permission_mode === 'string' ? raw.permission_mode.slice(0, 40) : null,
    agentId: meta.agentId ?? null,
    hookPid: meta.hookPid,
  }
}

/**
 * A stored request read back, or null when it is not a well-formed schema 1
 * request. `kind` follows the tool name (a stored `kind` that disagrees
 * makes it malformed), and a question request must hold a whole, valid
 * `AskUserQuestion` input. Requests from hooks before 1.15 have no `kind`.
 * @param {unknown} raw
 * @returns {ApprovalRequest | null}
 */
export function readRequest(raw) {
  const r = /** @type {any} */ (raw)
  if (!r || typeof r !== 'object' || r.schema !== 1 || !isApprovalId(r.id) || typeof r.toolName !== 'string' || !HASH.test(r.inputHash)) return null
  if (!Number.isFinite(r.createdAt) || !Number.isFinite(r.expiresAt) || typeof r.cliSessionId !== 'string' || typeof r.truncated !== 'boolean' || !Number.isInteger(r.hookPid)) return null
  const kind = isQuestionRequest(r) ? 'question' : 'tool'
  if (r.kind !== undefined && r.kind !== kind) return null
  if (kind === 'question' && (r.truncated || !readQuestions(r.toolInput))) return null
  return { ...r, kind }
}

/**
 * Whether an answer file is addressed to `request` and dated inside its life:
 * schema 1, the request's own id and input hash, `at` between creation and
 * expiry, and read no later than just after expiry.
 * @param {any} a
 * @param {Pick<ApprovalRequest, 'id' | 'inputHash' | 'createdAt' | 'expiresAt'>} request
 * @param {number} now
 * @returns {boolean}
 */
function isAnswerFor(a, request, now) {
  if (!isPlainObject(a) || a.schema !== 1 || a.id !== request.id || a.inputHash !== request.inputHash || !Number.isFinite(a.at)) return false
  return a.at >= request.createdAt && a.at <= request.expiresAt && now <= request.expiresAt + APPROVAL_POLL_MS * 2
}

/**
 * What an answer file decides for a tool request at `now`: `allow`, `deny`
 * or `ask` (back to Claude's dialog); null while it is not a valid answer to
 * this very request (wrong id or hash, unknown behaviour, dated outside the
 * request's life). An allow for a truncated request becomes `ask`. Question
 * requests are decided by `questionDecision` (through `hookDecision`) only.
 * @param {unknown} answer
 * @param {Pick<ApprovalRequest, 'id' | 'inputHash' | 'createdAt' | 'expiresAt' | 'truncated'>} request
 * @param {number} now
 * @returns {'allow' | 'deny' | 'ask' | null}
 */
export function answerDecision(answer, request, now) {
  const a = /** @type {any} */ (answer)
  if (!isAnswerFor(a, request, now) || !APPROVAL_BEHAVIORS.includes(a.behavior)) return null
  if (a.behavior === 'allow' && request.truncated) return 'ask'
  return a.behavior
}

/**
 * The hook's stdout for answered questions: an allow whose `updatedInput` is
 * the original tool input with `answers` (question text → answer text) and,
 * only when there are notes, `annotations` (question text → `{ notes }`); any
 * `annotations` the model put in its input are dropped.
 * @param {unknown} toolInput the original `AskUserQuestion` input
 * @param {Record<string, string>} answers
 * @param {Record<string, string>} notes
 * @returns {string}
 */
export function questionOutput(toolInput, answers, notes) {
  const updatedInput = questionResult(toolInput, answers, notes)
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput } } })
}

/**
 * The answered `AskUserQuestion` input: the original with `answers` and, only
 * when there are notes, `annotations` (`{ notes }` per question); the model's
 * own `annotations` are dropped. It is both the hook's `updatedInput` and the
 * tool result a held question's mod returns.
 * @param {unknown} toolInput
 * @param {Record<string, string>} answers
 * @param {Record<string, string>} notes
 * @returns {Record<string, unknown>}
 */
export function questionResult(toolInput, answers, notes) {
  const { annotations: _modelAnnotations, ...rest } = isPlainObject(toolInput) ? /** @type {Record<string, unknown>} */ (toolInput) : {}
  const noted = Object.entries(notes)
  return { ...rest, answers, ...(noted.length ? { annotations: Object.fromEntries(noted.map(([q, text]) => [q, { notes: text }])) } : {}) }
}

/**
 * What an answer file decides for a question request at `now`: `answered`
 * with the hook's output when it is a valid `answer` to this very request
 * (re-checked against the request's own questions, so a forged or edited
 * answer file can only name offered labels or clean Other text), `declined`
 * (no output: the desktop asks) for `ask`; null otherwise.
 * @param {unknown} answer
 * @param {Pick<ApprovalRequest, 'id' | 'inputHash' | 'createdAt' | 'expiresAt' | 'toolInput'>} request
 * @param {number} now
 * @returns {HookDecision | null}
 */
export function questionDecision(answer, request, now) {
  const a = /** @type {any} */ (answer)
  if (!isAnswerFor(a, request, now)) return null
  if (a.behavior === 'ask') return { outcome: 'declined', output: null }
  if (a.behavior !== 'answer') return null
  const questions = readQuestions(request.toolInput)
  const checked = questions ? checkQuestionAnswer(questions, { answers: a.answers, notes: a.notes }) : null
  if (!checked?.ok) return null
  return { outcome: 'answered', output: questionOutput(request.toolInput, checked.answers, checked.notes) }
}

/**
 * The hook's decision for any request: tool requests through
 * `answerDecision` and `hookOutput`, question requests through
 * `questionDecision`. `outcome` goes to the done file; `output` null means
 * no output (Claude's own dialog or question card).
 * @param {unknown} answer
 * @param {ApprovalRequest} request
 * @param {number} now
 * @returns {HookDecision | null}
 */
export function hookDecision(answer, request, now) {
  if (isQuestionRequest(request)) return questionDecision(answer, request, now)
  const decision = answerDecision(answer, request, now)
  return decision ? { outcome: decision, output: hookOutput(decision) } : null
}

/**
 * The hook's stdout for a decision: an allow or deny with nothing else
 * (never `updatedInput` or `updatedPermissions`), or null for no output,
 * which leaves the call to Claude's own dialog.
 * @param {'allow' | 'deny' | 'ask' | null} decision
 * @returns {string | null}
 */
export function hookOutput(decision) {
  if (decision === 'allow') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  if (decision === 'deny') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: APPROVAL_DENY_MESSAGE } } })
  return null
}

/**
 * A message typed instead of an answer (2.1.6): only for a question asked in
 * Claude and Orbit at once (`held`), whose mod hands the text to the model as
 * the question's refusal. Plain text of 1 to 2,000 characters, no hidden ones.
 * @param {any} b
 * @param {ApprovalRequest} request
 * @returns {{ ok: true, behavior: 'dismiss', message: string } | { ok: false, status: 400, error: string }}
 */
function dismissal(b, request) {
  if (request.held !== true) return { ok: false, status: 400, error: 'Only a question open in Orbit and Claude at once can be dismissed with a message.' }
  const message = typeof b.message === 'string' ? b.message.trim() : ''
  if (!message || message.length > QUESTION_LIMITS.other) return { ok: false, status: 400, error: 'A message is 1 to 2,000 characters.' }
  if (HAS_HIDDEN.test(message.replace(LINE_CHARS, ''))) return { ok: false, status: 400, error: 'A message cannot hold control or hidden characters.' }
  return { ok: true, behavior: 'dismiss', message }
}

/**
 * Whether the server may record `body` as the answer to `request` at `now`:
 * a known behaviour, the request's own hash, before its last second, and
 * never an allow for a truncated request. For a question request:
 * `{ inputHash, answers, notes? }` (behaviour `answer`, checked by
 * `checkQuestionAnswer`; `chosen` and `notes` are what the server stores) or
 * `{ inputHash, behavior: 'ask' }` (answer in Claude); allow and deny are refused.
 * `ok` false carries an HTTP status and reason.
 * @param {unknown} body
 * @param {ApprovalRequest} request
 * @param {number} now
 * @returns {{ ok: true, behavior: 'allow' | 'deny' | 'ask' } | { ok: true, behavior: 'answer', answers: Record<string, QuestionChoice>, notes: Record<string, string> } | { ok: true, behavior: 'dismiss', message: string } | { ok: false, status: number, error: string }}
 */
export function checkAnswerPost(body, request, now) {
  const b = /** @type {any} */ (body)
  if (isQuestionRequest(request)) {
    const behavior = isPlainObject(b) ? b.behavior ?? (Object.hasOwn(b, 'answers') ? 'answer' : undefined) : undefined
    if (!QUESTION_BEHAVIORS.includes(behavior)) return { ok: false, status: 400, error: 'behavior must be answer, ask or dismiss' }
    if (b.inputHash !== request.inputHash) return { ok: false, status: 409, error: 'This request changed; it was not answered.' }
    if (now > request.expiresAt - 1_000) return { ok: false, status: 410, error: 'This question has expired; Claude asks it now.' }
    if (behavior === 'ask') return { ok: true, behavior: 'ask' }
    if (behavior === 'dismiss') return dismissal(b, request)
    const questions = readQuestions(request.toolInput)
    if (!questions) return { ok: false, status: 400, error: 'This question cannot be answered here.' }
    const checked = checkQuestionAnswer(questions, b)
    if (!checked.ok) return checked
    return { ok: true, behavior: 'answer', answers: checked.chosen, notes: checked.notes }
  }
  if (!b || !APPROVAL_BEHAVIORS.includes(b.behavior)) return { ok: false, status: 400, error: 'behavior must be allow, deny or ask' }
  if (b.inputHash !== request.inputHash) return { ok: false, status: 409, error: 'This request changed; it was not answered.' }
  if (now > request.expiresAt - 1_000) return { ok: false, status: 410, error: 'This request has expired; Claude asks for it now.' }
  if (b.behavior === 'allow' && request.truncated) return { ok: false, status: 400, error: 'This call is too long to show in full, so it can only be denied here or answered in Claude.' }
  return { ok: true, behavior: b.behavior }
}

/**
 * Text made safe to read: control, format, bidi and zero-width characters
 * (and a lone carriage return) become visible codes such as `⟨U+202E⟩`;
 * line feeds and tabs stay. `hidden` counts the characters replaced.
 * @param {string} text
 * @returns {{ text: string, hidden: number }}
 */
export function visibleText(text) {
  let hidden = 0
  const shown = text.replace(HIDDEN_CHAR, (ch, at) => {
    if (ch === '\n' || ch === '\t' || (ch === '\r' && text.charAt(at + 1) === '\n')) return ch
    hidden += 1
    return `⟨U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`
  })
  return { text: shown, hidden }
}

/**
 * What the page shows of a request: every part of its input as labelled
 * text (the main argument first; strings as they are, so file content and
 * Edit strings read as lines; other values and MCP inputs as JSON), with
 * hidden characters made visible, and the totals for the block's head. A
 * question request gives `kind: 'question'` with its `questions` instead
 * (question text, headers and labels exactly as asked, since answers name
 * them; descriptions and previews with hidden characters made visible and
 * counted in `hidden`), no `fields`, and zero lines and chars.
 * @param {ApprovalRequest} request
 * @returns {ApprovalView}
 */
export function approvalView(request) {
  const name = visibleText(request.toolName)
  const cwd = request.cwd === null ? null : visibleText(request.cwd)
  const aroundHidden = name.hidden + (cwd?.hidden ?? 0)
  if (isQuestionRequest(request)) {
    let hiddenInQuestions = aroundHidden
    const shown = (/** @type {string} */ text) => {
      const v = visibleText(text)
      hiddenInQuestions += v.hidden
      return v.text
    }
    const questions = (readQuestions(request.toolInput) ?? []).map(q => ({
      ...q,
      options: q.options.map(o => ({ label: o.label, description: shown(o.description), ...(o.preview !== undefined ? { preview: shown(o.preview) } : {}) })),
    }))
    return {
      id: request.id,
      kind: 'question',
      cliSessionId: request.cliSessionId,
      toolName: name.text,
      fields: [],
      lines: 0,
      chars: 0,
      hidden: hiddenInQuestions,
      truncated: false,
      cwd: cwd?.text ?? null,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      inputHash: request.inputHash,
      answered: null,
      questions,
      ...(request.held === true ? { held: true } : {}),
    }
  }
  const input = /** @type {any} */ (request.toolInput)
  const isObject = !request.truncated && input && typeof input === 'object' && !Array.isArray(input) && !request.toolName.startsWith('mcp__')
  /** @type {{ label: string, text: string }[]} */
  const parts = []
  if (request.truncated) parts.push({ label: 'input (cut at 16 KB)', text: String(input) })
  else if (!isObject) parts.push({ label: 'input', text: JSON.stringify(input, null, 2) ?? 'null' })
  else {
    const order = ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'path', 'query', 'prompt']
    const keys = Object.keys(input).sort((a, b) => (order.includes(a) ? order.indexOf(a) : 99) - (order.includes(b) ? order.indexOf(b) : 99) || a.localeCompare(b))
    for (const key of keys) parts.push({ label: key, text: typeof input[key] === 'string' ? input[key] : JSON.stringify(input[key], null, 2) ?? 'null' })
  }
  let hidden = aroundHidden
  const fields = parts.map(p => {
    const label = visibleText(p.label)
    const shown = visibleText(p.text)
    hidden += label.hidden + shown.hidden
    return { label: label.text, text: shown.text }
  })
  const raw = parts.map(p => p.text)
  return {
    id: request.id,
    kind: 'tool',
    cliSessionId: request.cliSessionId,
    toolName: name.text,
    fields,
    lines: raw.reduce((n, t) => n + t.split('\n').length, 0),
    chars: raw.reduce((n, t) => n + t.length, 0),
    hidden,
    truncated: request.truncated,
    cwd: cwd?.text ?? null,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    inputHash: request.inputHash,
    answered: null,
  }
}

/**
 * Whether an observation of the marker after a request's input shows the
 * end of the input on screen: the whole marker inside the viewport and
 * every box that clips it (the input's own scroll, the chat, the panel).
 * Scrolling the input box to its end is not enough when an outer box hides it.
 * @param {{ isIntersecting: boolean, intersectionRatio: number }} entry an IntersectionObserver entry, viewport as root
 * @returns {boolean}
 */
export function isEndOnScreen(entry) {
  return entry.isIntersecting && entry.intersectionRatio >= 0.99
}

/**
 * Which of the block's buttons work now. Both wait `APPROVAL_ARM_MS` after a
 * request is first shown (a click meant for something else, or a second
 * click, never lands on it) and while an answer is being sent; Allow also
 * waits until the whole input has been seen, and never works for a cut input.
 * @param {{ shownAt: number, now: number, isSeen: boolean, isPosting: boolean, truncated: boolean }} s
 * @returns {{ allow: boolean, deny: boolean, ask: boolean, why: string | null }}
 */
export function approvalButtons(s) {
  const armed = s.now - s.shownAt >= APPROVAL_ARM_MS && !s.isPosting
  const why = s.truncated ? 'Too long to show in full: deny it or answer in Claude.' : !s.isSeen ? 'Read the whole call first: scroll to its end or expand it.' : null
  return { allow: armed && s.isSeen && !s.truncated, deny: armed, ask: !s.isPosting, why }
}

/**
 * The approvals the page treats as still waiting: not answered (here,
 * elsewhere or by the server) and not expired.
 * @param {readonly ApprovalView[]} approvals
 * @param {ReadonlyMap<string, ApprovalOutcome>} outcomes answers and endings seen by this window, by id
 * @param {number} now
 * @returns {ApprovalView[]}
 */
export function pendingApprovals(approvals, outcomes, now) {
  return approvals.filter(a => a.answered === null && !outcomes.has(a.id) && a.expiresAt > now)
}

/**
 * Endings for requests this window was showing that are no longer waiting
 * and that it did not answer itself: answered elsewhere (that answer), or
 * gone or past their time (`expired`).
 * @param {readonly ApprovalView[]} before the last list
 * @param {readonly ApprovalView[]} after the new list
 * @param {ReadonlyMap<string, ApprovalOutcome>} outcomes
 * @param {number} now
 * @returns {ApprovalOutcome[]}
 */
export function endedApprovals(before, after, outcomes, now) {
  const still = new Map(after.map(a => [a.id, a]))
  /** @type {ApprovalOutcome[]} */
  const out = []
  for (const a of before) {
    if (outcomes.has(a.id)) continue
    const next = still.get(a.id)
    const answered = next?.answered ?? a.answered
    if (next && next.answered === null && next.expiresAt > now) continue
    out.push({ id: a.id, outcome: answered ?? 'expired', cliSessionId: a.cliSessionId, toolName: a.toolName, at: now })
  }
  return out
}

/**
 * The outcome a failed answer means: gone (404, 409) or expired (410); null when it may be retried,
 * including a 409 with reason `no-window` (the server is waiting for a window to reconnect).
 * @param {number | undefined} status
 * @param {string} [reason]
 * @returns {'gone' | 'expired' | null}
 */
export function failedAnswerOutcome(status, reason) {
  if (status === 409 && reason === 'no-window') return null
  if (status === 410) return 'expired'
  if (status === 404 || status === 409) return 'gone'
  return null
}

/** @type {Record<ApprovalOutcome['outcome'], string>} */
const OUTCOME_TEXT = {
  dismiss: 'Dismissed with your message.',
  allow: 'Allowed.',
  deny: 'Denied.',
  ask: 'Sent to Claude: answer it there.',
  answer: 'Answered.',
  expired: 'Expired: Claude asks for it now.',
  gone: 'No longer waiting.',
}

/**
 * The last ending to show for a session (for `APPROVAL_OUTCOME_SHOWN_MS`), in words, or null.
 * A question's ending is named "Question".
 * @param {Iterable<ApprovalOutcome>} outcomes
 * @param {string | null} cliSessionId
 * @param {number} now
 * @returns {string | null}
 */
export function outcomeText(outcomes, cliSessionId, now) {
  /** @type {ApprovalOutcome | null} */
  let latest = null
  for (const o of outcomes) if (o.cliSessionId === cliSessionId && now - o.at < APPROVAL_OUTCOME_SHOWN_MS && (!latest || o.at > latest.at)) latest = o
  return latest ? `${isQuestionRequest(latest) ? 'Question' : latest.toolName}: ${OUTCOME_TEXT[latest.outcome]}` : null
}

/**
 * Pending approvals of one session, oldest first.
 * @param {readonly ApprovalView[]} approvals
 * @param {string | null} cliSessionId
 * @returns {ApprovalView[]}
 */
export function approvalsOf(approvals, cliSessionId) {
  if (!cliSessionId) return []
  return approvals.filter(a => a.cliSessionId === cliSessionId).sort((a, b) => a.createdAt - b.createdAt)
}

