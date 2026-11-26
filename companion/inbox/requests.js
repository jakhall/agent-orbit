import { APPROVAL_ARM_MS, approvalButtons, approvalsOf, checkQuestionAnswer, failedAnswerOutcome, isEndOnScreen, isQuestionRequest, outcomeText, pendingApprovals as pendingOf, QUESTION_LIMITS } from '/shared/approvals.js'
import { clockTime } from '/shared/format.js'
import { answeredQuestions, endedCardFate, endedCardNote, pruneById, chooseOption, emptyQuestionDraft, isNoWindow, isTypingDue, mayFocusNewCard, NO_WINDOW_TEXT, questionSendArmed, questionHint, questionPost, questionReview, tabAfterChoice } from '/shared/popout.js'
import { $, announce, api, el, hooks, selectedSession, state } from './ctx.js'

const rebuild = () => hooks.rerender()
const setStatus = (text, isBad = false) => hooks.status(text, isBad)

let postingId = null
let failure = null
let ticker = 0
let armTimer = 0
let endWatch = null
const shownAt = new Map()
const seen = new Set()
const expanded = new Set()
const scrollTops = new Map()
const answeredHere = new Set()
const permissionCards = new Map()

/** The approvals this window treats as still waiting: not answered here or elsewhere, not expired. */
export function pendingApprovals(now = Date.now()) {
  return pendingOf(state.approvals, state.approvalOutcomes, now)
}

function questionDraftError(a, draft) {
  const checked = checkQuestionAnswer(a.questions ?? [], draft)
  return checked.ok ? null : checked.error
}

async function sendQuestion(a, body, behavior) {
  if (postingId) return { ok: false, error: 'Another answer is being sent.' }
  postingId = a.id
  answeredHere.add(a.id)
  rebuild()
  try {
    await api('POST', `/api/approvals/${a.id}`, { ...body, inputHash: a.inputHash })
    state.approvalOutcomes.set(a.id, { id: a.id, outcome: behavior, cliSessionId: a.cliSessionId, toolName: a.toolName, at: Date.now() })
    return { ok: true }
  } catch (error) {
    const outcome = failedAnswerOutcome(error.status, error.detail?.reason)
    if (outcome) state.approvalOutcomes.set(a.id, { id: a.id, outcome, cliSessionId: a.cliSessionId, toolName: a.toolName, at: Date.now() })
    return { ok: false, status: error.status, outcome, error: isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : error.message }
  } finally {
    postingId = null
    rebuild()
  }
}

/** Answers a question request: `draft` is `{ answers: { [question]: { labels } | { other } }, notes?: { [question]: text } }`. Resolves `{ ok, status?, outcome?, error? }`; `outcome` 'gone' or 'expired' means it can no longer be answered here. */
export function answerQuestion(a, draft) {
  return sendQuestion(a, draft, 'answer')
}

/** "Answer in Claude": hands the question back to the desktop at once. Resolves like `answerQuestion`. */
export function declineQuestion(a) {
  return sendQuestion(a, { behavior: 'ask' }, 'ask')
}

/** The question this session has open in Claude and Orbit at once, which a typed message dismisses; null when none. */
export function heldQuestion(s) {
  return approvalsOf(pendingApprovals(), s.cliSessionId).find(a => isQuestionRequest(a) && a.held === true && !answeredHere.has(a.id)) ?? null
}

/** Dismisses a held question with the person's own message, which Claude reads instead of an answer. Resolves like `answerQuestion`. */
export function dismissQuestion(a, message) {
  return sendQuestion(a, { behavior: 'dismiss', message }, 'dismiss')
}

/** Called after the details are drawn: remembers what the block shows and wires its scroll box and buttons. */
export function approvalDrawn() {
  focusNewQuestion()
  const box = $('approval-input')
  if (!box) return
  const id = box.dataset.id
  if (!shownAt.has(id)) shownAt.set(id, Date.now())
  const check = () => {
    const more = $('approval-expand')
    if (more) more.hidden = expanded.has(id) || box.scrollHeight <= box.clientHeight + 2
    updateButtons()
  }
  if (!box.dataset.wired) {
    box.dataset.wired = 'true'
    if (scrollTops.has(id)) box.scrollTop = scrollTops.get(id)
    box.addEventListener('scroll', () => {
      scrollTops.set(id, box.scrollTop)
      check()
    })
  }
  endWatch?.disconnect()
  const end = $('approval-end')
  if (end && !seen.has(id)) {
    endWatch = new IntersectionObserver(
      entries => {
        if (!entries.some(isEndOnScreen)) return
        seen.add(id)
        endWatch?.disconnect()
        updateButtons()
      },
      { threshold: 1 },
    )
    endWatch.observe(end)
  }
  check()
  clearTimeout(armTimer)
  armTimer = setTimeout(updateButtons, Math.max(0, shownAt.get(id) + APPROVAL_ARM_MS - Date.now()) + 20)
}

function updateButtons() {
  const box = $('approval-input')
  if (!box) return
  const a = state.approvals.find(x => x.id === box.dataset.id)
  if (!a) return
  const can = approvalButtons({ shownAt: shownAt.get(a.id) ?? Date.now(), now: Date.now(), isSeen: seen.has(a.id), isPosting: postingId === a.id, truncated: a.truncated })
  for (const [id, ok] of [['approval-allow', can.allow], ['approval-deny', can.deny], ['approval-ask', can.ask]]) {
    const button = $(id)
    if (button) button.disabled = !ok
  }
  const why = $('approval-why')
  if (why) {
    why.textContent = can.why ?? ''
    why.hidden = !can.why
  }
}

async function answer(a, behavior) {
  if (postingId) return
  postingId = a.id
  failure = null
  rebuild()
  try {
    await api('POST', `/api/approvals/${a.id}`, { behavior, inputHash: a.inputHash })
    state.approvalOutcomes.set(a.id, { id: a.id, outcome: behavior, cliSessionId: a.cliSessionId, toolName: a.toolName, at: Date.now() })
  } catch (error) {
    const outcome = failedAnswerOutcome(error.status, error.detail?.reason)
    if (outcome) state.approvalOutcomes.set(a.id, { id: a.id, outcome, cliSessionId: a.cliSessionId, toolName: a.toolName, at: Date.now() })
    else failure = { id: a.id, text: isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : error.message }
  } finally {
    postingId = null
    rebuild()
    focusAfterRequest()
  }
}

/** After a request is answered: the next request's title when one is waiting, else the outcome line; never the page body. */
function focusAfterRequest() {
  const next = document.querySelector('.cx-requests .approval:not(.done) .h-title')
  ;(next ?? $('approval-status') ?? $('cx-panel-title'))?.focus()
}

function secondsLeft(a) {
  return Math.max(0, Math.ceil((a.expiresAt - Date.now()) / 1000))
}

function leftText(a) {
  return a.held ? 'Also open in Claude' : `${secondsLeft(a)} s left`
}

function tick() {
  const left = $('approval-left')
  const a = left ? state.approvals.find(x => x.id === left.dataset.id) : null
  if (!left || !a || a.expiresAt <= Date.now()) {
    clearInterval(ticker)
    ticker = 0
    if (left) rebuild()
    return
  }
  left.textContent = leftText(a)
  updateButtons()
}

/** The first question of the question card `approvalBlock` shows for `s`, or null when it shows none. */
export function openQuestionText(s) {
  const a = approvalsOf(pendingApprovals(), s.cliSessionId)[0]
  const first = a && isQuestionRequest(a) ? a.questions?.[0]?.question : null
  return typeof first === 'string' ? first : null
}

/** The request card, pinned at the top of the panel: the oldest pending request with Allow, Deny and Answer in Claude, or how the last one ended (a question answered here shows its answer in the chat instead). */
export function approvalBlock(s) {
  const all = pendingApprovals()
  forgetQuestions(all)
  const pending = approvalsOf(all, s.cliSessionId)
  const a = pending[0]
  if (!a) {
    const shown = [...state.approvalOutcomes.values()].filter(o => !(isQuestionRequest(o) && o.outcome === 'answer'))
    const text = outcomeText(shown, s.cliSessionId, Date.now())
    return text ? el('section', { id: 'approval-status', class: 'approval done', role: 'status', tabindex: '-1' }, el('span', {}, text)) : null
  }
  if (!ticker) ticker = setInterval(tick, 1_000)
  if (isQuestionRequest(a)) return questionCard(a, pending)
  return permissionCard(a, pending)
}

/** The permission card for request `a`, built once and kept across redraws (so focus and reading position survive); only its countdown, queue and failure lines change. */
function permissionCard(a, pending) {
  let card = permissionCards.get(a.id)
  if (!card) {
    card = buildPermissionCard(a)
    permissionCards.set(a.id, card)
    announce(`${selectedSession()?.title ?? 'This session'} asks to run ${a.toolName}: Allow, Deny or Answer in Claude.`)
  }
  card.left.textContent = leftText(a)
  card.more.textContent = pending.length > 1 ? `+${pending.length - 1} more waiting` : ''
  card.more.hidden = pending.length <= 1
  const failText = failure?.id === a.id ? failure.text : ''
  if (card.failed.textContent !== failText) card.failed.textContent = failText
  card.failed.hidden = !failText
  return card.node
}

function buildPermissionCard(a) {
  const isExpanded = expanded.has(a.id)
  const button = (id, label, behavior, cls, title) => el('button', { id, class: cls, title, disabled: true, onclick: () => void answer(a, behavior) }, label)
  const left = el('span', { class: 'h-count', id: 'approval-left', 'data-id': a.id }, `${secondsLeft(a)} s left`)
  const more = el('span', { class: 'more-waiting', hidden: true })
  const failed = el('p', { class: 'note', role: 'alert', hidden: true })
  const node = el(
    'section',
    { class: 'approval', 'aria-label': `Permission request: ${a.toolName}` },
    el(
      'div',
      { class: 'approval-head' },
            el('span', { class: 'h-title', tabindex: '-1' }, `Allow ${a.toolName}?`),
      more,
      left,
    ),
    el('div', { class: 'approval-size' }, `${a.lines.toLocaleString('en-US')} ${a.lines === 1 ? 'line' : 'lines'} · ${a.chars.toLocaleString('en-US')} chars`),
    a.hidden ? el('p', { class: 'approval-warn', role: 'note' }, el('span', {}, `Contains hidden characters (${a.hidden}), shown as ⟨U+…⟩.`)) : null,
    el(
      'div',
      { id: 'approval-input', class: `approval-input${isExpanded ? ' expanded' : ''}`, 'data-id': a.id, tabindex: '0', 'aria-label': `${a.toolName} input` },
      ...a.fields.flatMap(f => [el('div', { class: 'approval-label' }, f.label), el('pre', {}, f.text)]),
      el('div', { id: 'approval-end', class: 'approval-end', 'aria-hidden': 'true' }),
    ),
    el(
      'button',
      {
        id: 'approval-expand',
        class: 'ghost small',
        hidden: true,
        onclick: event => {
          expanded.add(a.id)
          $('approval-input')?.classList.add('expanded')
          event.currentTarget.hidden = true
          updateButtons()
        },
      },
      'Show all',
    ),
    a.truncated ? el('p', { class: 'note' }, 'Too long to show in full, so it can only be denied here or answered in Claude.') : null,
    a.cwd ? el('div', { class: 'approval-meta', title: a.cwd }, el('span', {}, a.cwd)) : null,
    el(
      'div',
      { class: 'actions' },
      button('approval-allow', 'Allow', 'allow', 'primary', 'Let this call run once'),
      button('approval-deny', 'Deny', 'deny', '', 'Refuse it; the session is told "Denied from Orbit."'),
      button('approval-ask', 'Answer in Claude', 'ask', 'ghost', 'Show Claude’s own permission dialog now'),
    ),
    el('p', { id: 'approval-why', class: 'note', hidden: true }),
    failed,
  )
  return { node, left, more, failed }
}

const cards = new Map()
const questionDrafts = new Map()
const openNotes = new Set()
const focusedCards = new Set()
const activeTabs = new Map()
let cardSeq = 0

function draftKey(id, question) {
  return `${id}|${question}`
}

function draftsOf(a) {
  return Object.fromEntries((a.questions ?? []).map(q => [q.question, questionDrafts.get(draftKey(a.id, q.question)) ?? emptyQuestionDraft()]))
}

function dropQuestion(id) {
  cards.delete(id)
  focusedCards.delete(id)
  activeTabs.delete(id)
  for (const set of [questionDrafts, openNotes]) for (const key of [...set.keys()]) if (key.startsWith(`${id}|`)) set.delete(key)
}

function forgetQuestions(pending) {
  const live = new Set(pending.map(a => a.id))
  for (const byId of [shownAt, seen, expanded, scrollTops]) pruneById(byId, id => live.has(id))
  pruneById(answeredHere, id => live.has(id) || state.approvalOutcomes.has(id))
  pruneById(permissionCards, id => live.has(id))
  for (const id of [...cards.keys()]) if (!live.has(id)) dropQuestion(id)
}

function focusNewQuestion() {
  const card = $('question-card')
  if (!card || focusedCards.has(card.dataset.id)) return
  focusedCards.add(card.dataset.id)
  const drawn = cards.get(card.dataset.id)
  if (drawn && !drawn.tabs) {
    drawn.armFrom = Date.now()
    refreshQuestion(drawn)
  }
  const active = document.activeElement
  const isBody = !active || active === document.body
  const focus = { isBody, isInDetails: !isBody && Boolean(active.closest('#cx-panel')), isInComposer: !isBody && Boolean(active.closest('.composer')), isTextField: !isBody && active.matches('input[type="text"], textarea, select, [contenteditable]'), isInRequests: !isBody && Boolean(active.closest('.cx-requests')) }
  if (mayFocusNewCard(focus)) card.querySelector('.q-panel:not([hidden]) .q-opt input, .q-panel:not([hidden]) .q-link')?.focus({ preventScroll: true })
  else announceQuestion(card)
}

function announceQuestion(card) {
  const count = cards.get(card.dataset.id)?.a.questions?.length ?? 1
  const text = `Claude asks you ${count === 1 ? 'a question' : `${count} questions`}: the card is at the end of the conversation.`
  const region = $('cx-send-live')
  if (!region) return
  region.textContent = ''
  setTimeout(() => (region.textContent = text), 50)
}

function questionReason(a) {
  const drafts = draftsOf(a)
  return questionHint(a.questions ?? [], drafts) ?? questionDraftError(a, questionPost(a.questions ?? [], drafts))
}

function reviewList(card) {
  return questionReview(card.a.questions ?? [], draftsOf(card.a)).map(row =>
    el(
      'li',
      { class: `q-rev${row.isAnswered ? '' : ' open'}` },
      el('span', { class: 'q-rev-name' }, row.name),
      el('span', { class: 'q-rev-answer' }, row.isAnswered ? row.answer : el('span', {}, 'Not answered')),
      row.note ? el('span', { class: 'q-rev-note' }, `Note: ${row.note}`) : null,
      el('button', { class: 'ghost small q-link', 'data-tab': String(row.index), 'aria-label': `${row.isAnswered ? 'Edit' : 'Answer'} ${row.name}`, onclick: () => showTab(card, row.index, 'panel') }, row.isAnswered ? 'Edit' : 'Answer'),
    ),
  )
}

function refreshQuestion(card) {
  const isPosting = postingId !== null
  const reason = questionReason(card.a)
  const isArmed = questionSendArmed(card.armFrom, Date.now())
  card.send.disabled = Boolean(reason) || isPosting || !isArmed
  for (const button of card.asks) button.disabled = isPosting
  card.why.textContent = postingId === card.a.id ? 'Sending…' : (reason ?? (isArmed ? 'Ready to send.' : 'Ready to send in a moment.'))
  clearTimeout(card.armTimer)
  if (!isArmed && card.armFrom !== null) card.armTimer = setTimeout(() => refreshQuestion(card), Math.max(0, card.armFrom + APPROVAL_ARM_MS - Date.now()) + 20)
  card.error.textContent = card.failure ?? ''
  card.error.hidden = !card.failure
  if (!card.tabs) return
  const answered = answeredQuestions(card.a.questions ?? [], draftsOf(card.a))
  card.tabs.forEach((tab, i) => {
    if (i >= answered.length) return
    tab.classList.toggle('done', answered[i])
    tab.querySelector('.q-tab-state').textContent = answered[i] ? ', answered' : ''
  })
  const hadFocus = card.review.contains(document.activeElement) ? document.activeElement.dataset.tab : null
  card.review.replaceChildren(...reviewList(card))
  if (hadFocus !== null) card.review.querySelector(`[data-tab="${hadFocus}"]`)?.focus()
}

function showTab(card, index, focus = null) {
  if (!card.tabs) return
  const count = card.tabs.length
  const next = Math.max(0, Math.min(count - 1, index))
  activeTabs.set(card.a.id, next)
  card.tabs.forEach((tab, i) => {
    tab.setAttribute('aria-selected', String(i === next))
    tab.tabIndex = i === next ? 0 : -1
    card.panels[i].hidden = i !== next
  })
  const isSubmit = next === count - 1
  if (isSubmit && card.armFrom === null) card.armFrom = Date.now()
  else if (!isSubmit) card.armFrom = null
  refreshQuestion(card)
  if (focus === 'tab') card.tabs[next].focus()
  else if (focus === 'panel') {
    const panel = card.panels[next]
    const target = panel.querySelector('.q-opt input:checked') ?? panel.querySelector('.q-opt input') ?? panel.querySelector('.q-rev.open .q-link') ?? panel.querySelector('.q-rev .q-link') ?? card.tabs[next]
    target?.focus()
  }
}

async function finishQuestion(card, send) {
  if (postingId) return
  card.failure = null
  const result = await send()
  if (result.ok || result.outcome) {
    dropQuestion(card.a.id)
    if (result.status === 409 && card.hadFailure) setStatus('Question: probably answered already: an earlier send may have reached Orbit before the error.')
    else if (result.outcome) setStatus(outcomeText([state.approvalOutcomes.get(card.a.id)].filter(Boolean), card.a.cliSessionId, Date.now()) ?? 'Question: No longer waiting.')
    focusAfterRequest()
    return
  }
  card.hadFailure = true
  card.failure = result.error ?? 'Couldn’t send the answers.'
  refreshQuestion(card)
}

function submitQuestion(card) {
  const a = card.a
  if (questionReason(a) || !questionSendArmed(card.armFrom, Date.now())) return
  return finishQuestion(card, () => answerQuestion(a, questionPost(a.questions ?? [], draftsOf(a))))
}

const ARROW_NAV_MS = 150

const typingAt = new Map()

/** Tells the server someone is answering this question, at most every 10 s, so it stays open (E-23). */
function noteTyping(a) {
  const now = Date.now()
  if (!isTypingDue(typingAt.get(a.id) ?? null, now)) return
  typingAt.set(a.id, now)
  void api('POST', `/api/approvals/${a.id}/typing`, {}).catch(() => undefined)
}

function questionSet(card, q, qi) {
  const a = card.a
  const count = a.questions?.length ?? 0
  const key = draftKey(a.id, q.question)
  const name = `q-${card.n}-${qi}`
  const type = q.multiSelect ? 'checkbox' : 'radio'
  const title = q.header || 'this question'
  const get = () => questionDrafts.get(key) ?? emptyQuestionDraft()
  let focusLabel = null
  let arrowAt = -Infinity
  const previewHead = el('div', { class: 'q-preview-head' })
  const previewText = el('pre', { tabindex: '0' })
  const preview = el('div', { class: 'q-preview', hidden: true }, previewHead, previewText)
  const showPreview = () => {
    const d = get()
    const withPreview = label => q.options.find(o => o.label === label && o.preview !== undefined)
    const option = withPreview(focusLabel) ?? [...d.labels].reverse().map(withPreview).find(Boolean)
    preview.hidden = !option
    if (!option) return
    previewHead.textContent = `Preview · ${option.label}`
    previewText.setAttribute('aria-label', `Preview of ${option.label}`)
    if (previewText.textContent !== option.preview) previewText.textContent = option.preview
  }
  const advance = label => {
    const next = card.tabs ? tabAfterChoice(qi, count, q.multiSelect, label, true) : null
    if (next !== null) showTab(card, next, 'panel')
  }
  const option = (id, labelText, desc, onToggle, onFocus) => {
    const input = el('input', { type, name, id, 'aria-labelledby': `${id}-l`, 'aria-describedby': desc ? `${id}-d` : null })
    input.addEventListener('change', () => onToggle(input.checked))
    input.addEventListener('focus', () => onFocus(true))
    input.addEventListener('blur', () => onFocus(false))
    input.addEventListener('keydown', event => {
      if (event.key.startsWith('Arrow')) arrowAt = performance.now()
    })
    const row = el('label', { class: 'q-opt' }, input, el('span', { class: 'q-label', id: `${id}-l` }, labelText), desc ? el('span', { class: 'q-desc', id: `${id}-d`, 'aria-hidden': 'true' }, desc) : null)
    return { input, row }
  }
  const update = next => {
    noteTyping(a)
    questionDrafts.set(key, next)
    sync()
    refreshQuestion(card)
  }
  const options = q.options.map((o, oi) => {
    const made = option(
      `${name}-${oi}`,
      o.label,
      o.description,
      isOn => {
        update(chooseOption(q.multiSelect, get(), o.label, isOn))
        if (isOn && performance.now() - arrowAt > ARROW_NAV_MS) advance(o.label)
      },
      isIn => {
        focusLabel = isIn ? o.label : null
        showPreview()
      },
    )
    if (!q.multiSelect) {
      made.input.addEventListener('keydown', event => {
        if (event.key !== ' ' || !made.input.checked) return
        event.preventDefault()
        advance(o.label)
      })
    }
    return made
  })
  const otherText = el('input', { type: 'text', class: 'q-other', maxlength: QUESTION_LIMITS.other, 'aria-label': `Other answer for ${title}`, placeholder: 'Type your own answer', hidden: true })
  const other = option(
    `${name}-o`,
    'Other',
    null,
    isOn => {
      update(chooseOption(q.multiSelect, get(), null, isOn))
      if (isOn) otherText.focus()
    },
    () => {},
  )
  otherText.addEventListener('input', () => {
    noteTyping(a)
    questionDrafts.set(key, { ...get(), other: otherText.value })
    refreshQuestion(card)
  })
  const noteId = `${name}-note`
  const note = el('textarea', { id: noteId, class: 'q-note', rows: 2, maxlength: QUESTION_LIMITS.notes, 'aria-label': `Note for ${title}`, hidden: !openNotes.has(key) })
  note.addEventListener('input', () => {
    noteTyping(a)
    questionDrafts.set(key, { ...get(), note: note.value })
    refreshQuestion(card)
  })
  const noteButton = el('button', { class: 'ghost small q-link', 'aria-expanded': String(openNotes.has(key)), 'aria-controls': noteId }, openNotes.has(key) ? 'Hide note' : 'Add a note')
  noteButton.addEventListener('click', () => {
    const isOpen = !openNotes.has(key)
    if (isOpen) openNotes.add(key)
    else openNotes.delete(key)
    note.hidden = !isOpen
    noteButton.setAttribute('aria-expanded', String(isOpen))
    noteButton.textContent = isOpen ? 'Hide note' : 'Add a note'
    if (isOpen) note.focus()
  })
  function sync() {
    const d = get()
    q.options.forEach((o, oi) => {
      options[oi].input.checked = d.labels.includes(o.label)
    })
    other.input.checked = d.isOther
    otherText.hidden = !d.isOther
    if (otherText.value !== d.other) otherText.value = d.other
    if (note.value !== d.note) note.value = d.note
    showPreview()
  }
  sync()
  const nav = card.tabs
    ? [
        qi > 0 ? el('button', { class: 'small', onclick: () => showTab(card, qi - 1, 'panel') }, 'Back') : null,
        el('button', { class: 'small', onclick: () => showTab(card, qi + 1, 'panel') }, qi + 1 < count ? 'Next' : 'Review'),
      ]
    : []
  return [
    el(
      'fieldset',
      { class: 'q-set' },
      el('legend', {}, q.header && !card.tabs ? el('span', { class: 'q-chip' }, q.header) : null, el('span', { class: 'q-text' }, q.question), el('span', { class: 'q-mode' }, q.multiSelect ? 'Choose any' : 'Choose one')),
      el('div', { class: 'q-opts' }, ...options.map(x => x.row), other.row, otherText),
      preview,
    ),
    note,
    el('div', { class: 'q-nav' }, noteButton, el('span', { class: 'q-nav-gap' }), ...nav),
  ]
}

function tabStrip(card, questions) {
  const labels = [...questions.map((q, i) => q.header || `Question ${i + 1}`), 'Submit']
  card.tabs = labels.map((label, i) => {
    const isSubmit = i === questions.length
    return el(
      'button',
      { class: `q-tab${isSubmit ? ' submit' : ''}`, role: 'tab', id: `q-tab-${card.n}-${i}`, 'aria-controls': `q-panel-${card.n}-${i}`, 'aria-selected': 'false', tabindex: '-1', onclick: () => showTab(card, i) },
      isSubmit ? null : el('span', { class: 'q-tab-check', 'aria-hidden': 'true' }, '✓'),
      el('span', {}, label),
      el('span', { class: 'sr-only q-tab-state' }),
    )
  })
  const list = el('div', { class: 'q-tabs', role: 'tablist', 'aria-label': 'Questions' }, ...card.tabs)
  list.addEventListener('keydown', event => {
    const at = card.tabs.indexOf(document.activeElement)
    if (at < 0) return
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: card.tabs.length - 1 }[event.key]
    if (next === undefined) return
    event.preventDefault()
    showTab(card, (next + card.tabs.length) % card.tabs.length, 'tab')
  })
  return list
}

function buildQuestionCard(a) {
  cardSeq += 1
  const questions = a.questions ?? []
  const isTabbed = questions.length > 1
  const card = { a, n: cardSeq, failure: null, hadFailure: false, tabs: null, panels: [], asks: [], armFrom: null, armTimer: 0 }
  const titleId = `q-title-${card.n}`
  const decline = () => void finishQuestion(card, () => declineQuestion(a))
  card.left = el('span', { class: 'h-count', id: 'approval-left', 'data-id': a.id, title: a.held ? 'Answer here or in Claude: the first answer counts' : '' }, leftText(a))
  card.why = el('p', { class: 'note q-why', id: `q-why-${card.n}` })
  card.send = el('button', { class: 'primary', id: 'question-send', 'aria-describedby': card.why.id }, 'Send answers')
  card.send.addEventListener('click', () => void submitQuestion(card))
  const ask = el('button', { class: 'ghost', id: 'question-ask', title: 'Show Claude’s own question card now', onclick: decline }, 'Answer in Claude')
  const headAsk = isTabbed ? el('button', { class: 'ghost small q-head-ask', title: 'Show Claude’s own question card now', onclick: decline }, 'Answer in Claude') : null
  card.asks = [ask, headAsk].filter(Boolean)
  card.error = el('p', { class: 'note err', role: 'alert', hidden: true })
  card.more = el('span', { class: 'more-waiting', hidden: true })
  const strip = isTabbed ? tabStrip(card, questions) : null
  const actions = [el('div', { class: 'actions' }, card.send, ask), card.why]
  if (isTabbed) {
    card.review = el('ul', { class: 'q-review' })
    card.panels = [
      ...questions.map((q, qi) => el('div', { class: 'q-panel', role: 'tabpanel', id: `q-panel-${card.n}-${qi}`, 'aria-labelledby': `q-tab-${card.n}-${qi}`, hidden: true }, ...questionSet(card, q, qi))),
      el('div', { class: 'q-panel q-submit', role: 'tabpanel', id: `q-panel-${card.n}-${questions.length}`, 'aria-labelledby': `q-tab-${card.n}-${questions.length}`, hidden: true }, card.review, ...actions),
    ]
  } else {
    card.panels = [el('div', { class: 'q-panel' }, ...questions.flatMap((q, qi) => questionSet(card, q, qi)), ...actions)]
  }
  const time = clockTime(a.createdAt)
  card.node = el(
    'section',
    { id: 'question-card', class: `approval question-card${isTabbed ? ' tabbed' : ''}${a.held ? ' held' : ''}`, 'data-id': a.id, 'data-expires': a.expiresAt, 'aria-labelledby': titleId },
    el('div', { class: 'approval-head' }, el('span', { class: 'h-title', id: titleId, tabindex: '-1', title: `Asked at ${time}` }, 'Claude asks'), isTabbed ? null : el('span', { class: 'q-time', title: time }, time.slice(11)), card.more, card.left, headAsk),
    a.hidden ? el('p', { class: 'approval-warn', role: 'note' }, el('span', {}, `Contains hidden characters (${a.hidden}), shown as ⟨U+…⟩.`)) : null,
    strip,
    ...card.panels,
    card.error,
  )
  if (isTabbed) {
    const firstOpen = answeredQuestions(questions, draftsOf(a)).indexOf(false)
    showTab(card, activeTabs.get(a.id) ?? (firstOpen < 0 ? questions.length : firstOpen))
  }
  return card
}

/**
 * The question card in `container` that ended while focused and was not
 * answered from this window: kept in place, frozen, instead of `next`, until
 * focus leaves it. Null when the redraw may replace it.
 */
export function holdEndedCard(container, next) {
  const shown = [...container.children].find(n => n.classList.contains('question-card'))
  if (!shown || shown === next) return null
  const id = shown.dataset.id
  if (endedCardFate({ hasFocus: shown.contains(document.activeElement), isAnsweredHere: answeredHere.has(id) || postingId === id }) !== 'freeze') return null
  const outcome = state.approvalOutcomes.get(id)?.outcome ?? (Number(shown.dataset.expires) <= Date.now() ? 'expired' : undefined)
  freezeQuestionCard(shown, endedCardNote(outcome), rebuild)
  return shown
}

function freezeQuestionCard(node, note, onRelease) {
  if (node.dataset.ended) return
  node.dataset.ended = 'true'
  node.removeAttribute('id')
  node.classList.add('ended')
  for (const field of node.querySelectorAll('input[type="text"], textarea')) field.readOnly = true
  for (const button of node.querySelectorAll('button')) {
    button.setAttribute('aria-disabled', 'true')
    button.removeAttribute('id')
  }
  const left = node.querySelector('#approval-left')
  if (left) {
    left.removeAttribute('id')
    left.textContent = 'Ended'
  }
  node.querySelector('.approval-head')?.after(el('p', { class: 'note' }, note))
  announce(note, true)
  const stop = event => {
    if (event.type === 'keydown' && ['Tab', 'Escape', 'Shift'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
  }
  node.addEventListener('click', stop, true)
  node.addEventListener('keydown', stop, true)
  node.addEventListener('focusout', event => {
    if (!node.contains(event.relatedTarget)) setTimeout(onRelease, 0)
  })
}

function questionCard(a, pending) {
  let card = cards.get(a.id)
  if (!card) {
    card = buildQuestionCard(a)
    cards.set(a.id, card)
  }
  card.left.textContent = leftText(a)
  card.more.textContent = pending.length > 1 ? `+${pending.length - 1} more waiting` : ''
  card.more.hidden = pending.length <= 1
  refreshQuestion(card)
  return card.node
}
