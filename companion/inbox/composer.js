import { checkReplyText, commandMenu, parseCommand } from '/shared/inbox.js'
import { chatBubble, canWake, isAwaitingAgent, composerButton, composerHint, isNoWindow, NO_WINDOW_TEXT, fieldFate, heldText, pollErrorStep, composerLabel, draftOf, readOnlyShort, readOnlyText, REPLY_OLDER_TEXT, replyDeadline, replyRefusal, sendAfterAck, composerPlaceholder, shownSuggestion, wantsSuggestion, sendBlock, sendMode, shellSendBlock, sendOf, sendUpdate, setDraft, stopText, withdrawOutcome } from '/shared/popout.js'
import { truncate } from '/shared/format.js'
import { $, announce as say, api, el, hooks, selectedSession, state } from './ctx.js'
import { followChat } from './chat.js'
import { barSpinner } from './asleep.js'
import { dismissQuestion, heldQuestion } from './requests.js'
import { icon } from './icons.js'
import { asleepCard } from './asleep.js'
import { openSkills } from './skills.js'

const renderDetail = () => hooks.rerender()
const isArmed = capability => hooks.isArmed(capability)
const setStatus = (text, isBad = false, action = null) => hooks.status(text, isBad, action)
const openSession = s => hooks.openSession(s)
const select = key => hooks.select(key)
const textButton = (label, onclick, attrs = {}) => el('button', { ...attrs, onclick }, label)

const FAST_POLL_MS = 750
const SLOW_POLL_MS = 3_000
const FAST_WAIT_MS = 15_000
const COMPOSER_LINES = 8

const WAITING_FOR_SESSION = 'Waiting for the session…'
const REPLY_TITLE = 'Arrives in the session as your own words, as if typed there. While Claude works it is queued and Claude reads it after its current step; choose Wait to send it when Claude finishes instead. While Claude asks a question here, a message skips the question and Claude reads your message instead. It cannot approve a permission: open the session for that. Enter sends, Shift+Enter starts a new line. Tab takes the dim suggested message, as in Claude.'

const WAITING = 'Not delivered yet: the session may be closed.'
const EXPIRED = 'Not delivered: it expired after a minute.'
const ASLEEP_PLACEHOLDER = 'Write now; send once it wakes'
const ASLEEP_SEND_TITLE = 'Wake the session to send'
const MAYBE = 'May have arrived. Check the session.'
const QUESTION_PLACEHOLDER = 'Or skip the question and write to Claude instead…'
const BUSY = 'One message at a time: wait for the one above, or withdraw it.'
const STOP_TITLE = 'Stop Claude (Esc in Claude). Type a message to queue it instead.'
const STOP_WAIT_MS = 20_000
const STOP_HOLD_MS = 5_000
const COMMANDS_FRESH_MS = 30_000
const COMMAND_HELD = 'Queued: runs when Claude finishes.'

let focusNext = null
let lastAnnounced = ''
const watches = new Map()
const stops = new Map()
let comp = null
let composerError = null
const commandLists = new Map()
const suggestions = new Map()

function isInFlight(send) {
  return send?.status === 'sending' || send?.status === 'waiting' || send?.status === 'expired'
}

/** Moves focus where the last message step asked for, if focus was in the chat (or nowhere) before the redraw. */
export function applySendFocus(wasInChat) {
  const target = focusNext
  focusNext = null
  if (!target || !wasInChat) return
  if (target === 'area') comp?.area.focus()
  else document.querySelector(`.chat-pending [data-focus="${target}"]`)?.focus()
}

function announce(send) {
  const text = send?.message ?? ''
  if (!text || text === lastAnnounced) return
  lastAnnounced = text
  say(text, send.status === 'failed' || send.status === 'unknown')
}

function setSend(next, focus = null) {
  state.send = next
  focusNext = focus
  announce(next)
  renderDetail()
}

function autoGrow(area) {
  if (CSS.supports('field-sizing', 'content')) return
  const style = getComputedStyle(area)
  const line = Number.parseFloat(style.lineHeight) || 19
  const edge = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
  area.style.height = 'auto'
  area.style.height = `${Math.min(area.scrollHeight + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth), line * COMPOSER_LINES + edge)}px`
}

function buildComposer(key) {
  const label = el('div', { class: 'composer-label sr-only', id: 'composer-label' })
  const area = el('textarea', { rows: 1, maxlength: 4000, 'data-focus': 'area', 'aria-labelledby': 'composer-label', spellcheck: 'true' })
  const error = el('p', { class: 'err', id: 'composer-error', role: 'alert', hidden: true })
  const button = el('button', { class: 'icon-btn cx-send', 'aria-label': 'Send (Enter)', title: 'Send (Enter)', 'data-mode': 'send', onclick: () => (button.dataset.mode === 'stop' ? void stopSession() : submit()) }, icon('send'))
  const menu = el('div', { class: 'cmd-menu', hidden: true })
  const list = el('ul', { class: 'cmd-list', role: 'listbox', id: 'cmd-list', 'aria-label': 'Commands' })
  const hint = el('p', { class: 'cmd-hint note', id: 'cmd-hint' })
  menu.append(list, hint)
  area.setAttribute('aria-autocomplete', 'list')
  area.setAttribute('aria-controls', 'cmd-list')
  area.setAttribute('aria-expanded', 'false')
  area.value = draftOf(state.drafts, key)
  area.addEventListener('input', () => {
    setDraft(state.drafts, key, area.value)
    if (composerError?.key === key) showComposerError(key, null)
    autoGrow(area)
    syncMenu()
    const s = selectedSession()
    if (s?.key === key) syncButton(s)
  })
  area.addEventListener('blur', () => {
    if (comp?.area === area && comp.isFrozen) setTimeout(renderDetail, 0)
    if (comp?.area === area) setTimeout(() => document.activeElement !== area && closeMenu(), 150)
  })
  area.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return
    if (menuKey(event)) return
    if (takeSuggestion(event)) return
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return
    event.preventDefault()
    submit()
  })
  const skill = el('button', { class: 'icon-btn ghost cx-skill', type: 'button', 'aria-label': 'Apply skill', 'aria-keyshortcuts': 'A', title: 'Apply skill (a)', 'aria-haspopup': 'dialog', onclick: () => openSkillShelf() }, icon('skill'))
  const root = el('div', { class: 'composer' }, label, menu, error, el('div', { class: 'send-row' }, area, skill, button))
  return { key, root, label, area, error, button, skill, menu, list, hint, items: [], active: 0, dismissed: null, isFrozen: false, suggestion: null }
}

function takeSuggestion(event) {
  if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false
  if (!comp || comp.area !== event.target || comp.area.value !== '' || !comp.suggestion) return false
  event.preventDefault()
  comp.area.value = comp.suggestion
  comp.area.setSelectionRange(comp.area.value.length, comp.area.value.length)
  comp.area.dispatchEvent(new Event('input'))
  return true
}

function suggestionOf(s) {
  if (!wantsSuggestion(s, state.showConvo)) {
    suggestions.delete(s.key)
    return null
  }
  const entry = suggestions.get(s.key)
  if (!entry || entry.activityAt !== s.lastActivityAt) void loadSuggestion(s)
  return entry?.text ?? null
}

async function loadSuggestion(s) {
  const key = s.key
  const activityAt = s.lastActivityAt
  const previous = suggestions.get(key)
  if (previous?.loading && previous.activityAt === activityAt) return
  suggestions.set(key, { activityAt, text: previous?.text ?? null, loading: true })
  let text = null
  try {
    const answer = await api('GET', `/api/suggestion?key=${encodeURIComponent(key)}`)
    text = typeof answer?.text === 'string' ? answer.text : null
  } catch {
    text = null
  }
  if (suggestions.get(key)?.activityAt !== activityAt) return
  suggestions.set(key, { activityAt, text, loading: false })
  const latest = selectedSession()
  if (latest?.key === key) updateComposer(latest)
}

/** The session's slash commands as the page last fetched them (`known` false when its Orbit published none lately); fetched again when older than half a minute. */
export function commandsFor(key) {
  return commandsOf(key)
}

function commandsOf(key) {
  const entry = commandLists.get(key)
  if (!entry || (!entry.loading && Date.now() - entry.at > COMMANDS_FRESH_MS)) void loadCommands(key)
  return entry ?? null
}

async function loadCommands(key) {
  const previous = commandLists.get(key)
  commandLists.set(key, { at: previous?.at ?? 0, known: previous?.known ?? false, commands: previous?.commands ?? [], loading: true })
  let answer = null
  try {
    answer = await api('GET', `/api/commands?sessionKey=${encodeURIComponent(key)}`)
  } catch {
    answer = null
  }
  const next = { at: Date.now(), known: answer?.known === true, commands: Array.isArray(answer?.commands) ? answer.commands : [], loading: false }
  commandLists.set(key, next)
  if (comp?.key === key) syncMenu()
  if (previous?.known !== next.known || previous?.commands.length !== next.commands.length) renderDetail()
}

function closeMenu() {
  if (!comp) return
  comp.menu.hidden = true
  comp.items = []
  comp.area.setAttribute('aria-expanded', 'false')
  comp.area.removeAttribute('aria-activedescendant')
}

/** Shows the `/` menu for the draft being typed, or hides it. */
function syncMenu() {
  if (!comp) return
  const draft = comp.area.value
  if (!draft.startsWith('/') || draft === comp.dismissed) return closeMenu()
  comp.dismissed = null
  const entry = commandsOf(comp.key)
  const menu = commandMenu(draft, entry?.known ? entry.commands : null)
  if (!menu) return closeMenu()
  const isLoading = !entry?.known && (entry === null || entry.loading)
  comp.items = menu.items
  comp.active = Math.min(comp.active, Math.max(0, menu.items.length - 1))
  comp.list.replaceChildren(
    ...menu.items.map((c, i) =>
      el(
        'li',
        { id: `cmd-opt-${i}`, role: 'option', class: 'cmd-opt', 'aria-selected': i === comp.active ? 'true' : 'false', onmousedown: event => (event.preventDefault(), completeCommand(i)) },
        el('span', { class: 'cmd-name' }, `/${c.name}`),
        c.description ? el('span', { class: 'cmd-desc' }, c.description) : null,
      ),
    ),
  )
  comp.list.hidden = menu.items.length === 0
  comp.hint.textContent = isLoading ? 'Loading this session’s commands…' : (menu.hint ?? '')
  comp.hint.hidden = !comp.hint.textContent
  comp.menu.hidden = false
  comp.area.setAttribute('aria-expanded', menu.items.length > 0 ? 'true' : 'false')
  if (menu.items.length > 0) {
    comp.area.setAttribute('aria-activedescendant', `cmd-opt-${comp.active}`)
    comp.list.querySelector(`#cmd-opt-${comp.active}`)?.scrollIntoView({ block: 'nearest' })
  } else comp.area.removeAttribute('aria-activedescendant')
  comp.area.setAttribute('aria-describedby', composerError?.key === comp.key && composerError.text ? 'composer-error' : 'cmd-hint')
}

function completeCommand(index) {
  const chosen = comp?.items[index]
  if (!chosen) return
  comp.area.value = `/${chosen.name} `
  setDraft(state.drafts, comp.key, comp.area.value)
  comp.area.setSelectionRange(comp.area.value.length, comp.area.value.length)
  comp.active = 0
  closeMenu()
  autoGrow(comp.area)
  comp.area.focus()
}

/** Arrow keys, Enter, Tab and Esc while the `/` menu lists commands; true when the key was the menu's. */
function menuKey(event) {
  if (!comp || comp.menu.hidden) return false
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    comp.dismissed = comp.area.value
    closeMenu()
    return true
  }
  const count = comp.items.length
  if (count === 0) return false
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    comp.active = (comp.active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
    syncMenu()
    return true
  }
  if ((event.key === 'Enter' && !event.shiftKey && !event.altKey) || (event.key === 'Tab' && !event.shiftKey)) {
    const chosen = comp.items[comp.active]
    if (event.key === 'Enter' && chosen && comp.area.value === `/${chosen.name}`) {
      closeMenu()
      return false
    }
    event.preventDefault()
    completeCommand(comp.active)
    return true
  }
  return false
}

function showComposerError(key, text, isInvalid = false) {
  composerError = text ? { key, text, isInvalid } : null
  if (comp?.key !== key) return
  comp.error.textContent = text ?? ''
  comp.error.hidden = !text
  if (text) comp.area.setAttribute('aria-describedby', 'composer-error')
  else if (!comp.menu.hidden && !comp.hint.hidden) comp.area.setAttribute('aria-describedby', 'cmd-hint')
  else comp.area.removeAttribute('aria-describedby')
  comp.area.setAttribute('aria-invalid', text && isInvalid ? 'true' : 'false')
}

/** Refreshes the composer's route line and busy state in place, never touching its text or focus. */
export function updateComposer(s) {
  if (!comp || comp.key !== s.key) return
  const send = sendOf(state.send, s.key)
  const label = composerLabel(s.title)
  if (comp.label.textContent !== label) comp.label.textContent = label
  comp.area.title = REPLY_TITLE
  const { placeholder: usual } = composerHint()
  const isAsking = Boolean(heldQuestion(s))
  const isBusy = isInFlight(send)
  comp.suggestion = shownSuggestion(s, { text: suggestionOf(s), showConvo: state.showConvo, isBusy, isAsking })
  const placeholder = composerPlaceholder({ isAsking, suggestion: comp.suggestion, canMessage: Boolean(s.canMessage) }, { usual, asleep: ASLEEP_PLACEHOLDER, question: QUESTION_PLACEHOLDER })
  if (comp.area.placeholder !== placeholder) comp.area.placeholder = placeholder
  comp.area.classList.toggle('has-suggestion', comp.suggestion !== null)
  if (comp.suggestion) comp.area.setAttribute('aria-keyshortcuts', 'Tab')
  else comp.area.removeAttribute('aria-keyshortcuts')
  syncButton(s)
  if (!isBusy && composerError?.key === s.key && composerError.text === BUSY) composerError = null
  showComposerError(s.key, composerError?.key === s.key ? composerError.text : null, composerError?.isInvalid)
}

/** The message box pinned under the chat (kept across redraws, so its text, caret and focus survive), or why the session cannot take one; an asleep session Orbit can wake gets its asleep card over a box you can type in but not send from. */
export function composerArea(s) {
  return [asleepCard(s), composer(s)].filter(node => node !== null)
}

function composer(s) {
  const paused = state.shell ? shellSendBlock(state.shell) : null
  const block = !s.canMessage && !canWake(s) ? { short: readOnlyShort(s), text: readOnlyText(s) } : (paused ?? sendBlock(sendMode(s, isArmed('replies'))))
  const fate = fieldFate(comp?.key === s.key && comp.area === document.activeElement, block === null)
  if (fate === 'frozen') {
    freezeComposer(s, block.short)
    return comp.root
  }
  if (fate === 'gone') {
    if (comp?.key === s.key) comp = null
    return el('div', { class: 'chat-readonly', title: block.text }, el('span', { 'aria-hidden': 'true' }, block.short), el('span', { class: 'sr-only' }, block.text), paused ? null : blockAction(s))
  }
  if (!comp || comp.key !== s.key) {
    comp = buildComposer(s.key)
    if (composerError?.key !== s.key) composerError = null
  }
  if (comp.isFrozen) {
    comp.isFrozen = false
    comp.area.readOnly = false
    composerError = null
  }
  updateComposer(s)
  return comp.root
}

function isStopHeld(key) {
  const stop = stops.get(key)
  if (!stop) return false
  if (stop.status === 'pending') return true
  if (Date.now() - stop.settledAt < STOP_HOLD_MS) return stop.status === 'stopped'
  stops.delete(key)
  return false
}

function syncButton(s) {
  if (!comp || comp.key !== s.key || comp.isFrozen) return
  const mode = composerButton(s, isArmed('replies'), comp.area.value.trim() !== '')
  const isBusy = mode === 'stop' ? isStopHeld(s.key) : isInFlight(sendOf(state.send, s.key))
  const label = mode === 'stop' ? 'Stop' : 'Send (Enter)'
  const title = mode === 'stop' ? (isBusy ? stopText('pending') : STOP_TITLE) : isBusy ? BUSY : 'Send (Enter)'
  if (comp.button.dataset.mode !== mode) {
    comp.button.dataset.mode = mode
    comp.button.replaceChildren(icon(mode))
    comp.button.setAttribute('aria-label', label)
  }
  const isAsleep = !s.canMessage
  comp.button.title = isAsleep ? ASLEEP_SEND_TITLE : title
  comp.button.disabled = isAsleep
  comp.button.setAttribute('aria-disabled', String(isBusy || isAsleep))
  comp.skill.disabled = isAsleep
  comp.skill.title = isAsleep ? ASLEEP_SEND_TITLE : 'Apply skill (a)'
}

/**
 * Opens the skill explorer for the selected session, at `command`'s Apply
 * step when given and the session has it. Answers whether it opened.
 * @param {string | null} [command]
 * @returns {boolean}
 */
export function openSkillShelf(command = null) {
  const s = selectedSession()
  if (!s || !comp || comp.key !== s.key || comp.isFrozen || !s.canMessage) return false
  openSkills(s, sendLine, command)
  return true
}

async function stopSession() {
  const s = selectedSession()
  if (!s || !comp || s.key !== comp.key || comp.isFrozen || isStopHeld(s.key) || composerButton(s, isArmed('replies'), comp.area.value.trim() !== '') !== 'stop') return
  const key = s.key
  const settle = status => {
    stops.set(key, { status, settledAt: Date.now() })
    setStatus(stopText(status), status !== 'stopped' && status !== 'idle', status === 'failed' || status === 'expired' ? openAction(key) : null)
    renderDetail()
  }
  stops.set(key, { status: 'pending', settledAt: 0 })
  setStatus(stopText('pending'))
  syncButton(s)
  let id
  try {
    id = (await api('POST', '/api/stop', { sessionKey: key })).id
  } catch (error) {
    stops.delete(key)
    setStatus(isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : error.message, true, error.detail?.older ? openAction(key) : null)
    renderDetail()
    return
  }
  const until = Date.now() + STOP_WAIT_MS
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, FAST_POLL_MS))
    let result
    try {
      result = await api('GET', `/api/stop/${id}`)
    } catch (error) {
      if (pollErrorStep(error.status ?? 0, Date.now(), until) === 'retry') continue
      return settle('unknown')
    }
    if (result.status !== 'pending') return settle(result.status)
  }
  settle('unknown')
}

function openAction(key) {
  const s = state.lookup?.sessions.get(key)
  return s?.canOpen ? { label: 'Open in Claude', run: () => void openSession(s) } : null
}

function freezeComposer(s, why) {
  if (comp.isFrozen) return
  comp.isFrozen = true
  comp.area.readOnly = true
  comp.button.setAttribute('aria-disabled', 'true')
  comp.skill.disabled = true
  showComposerError(s.key, `${why} Your text is kept as a draft.`)
}

function openRepliesSetting() {
  hooks.showSwitches()
}

function blockAction(s) {
  if (!s.canMessage) return null
  const mode = sendMode(s, isArmed('replies'))
  if (mode === 'off') return el('button', { class: 'ghost small', onclick: openRepliesSetting }, 'How to turn on')
  if (mode === 'older' && s.canOpen) return el('button', { class: 'ghost small', onclick: () => void openSession(s) }, 'Open in Claude')
  return null
}

function copyButton(text) {
  return bubbleButton('copy', 'Copy text', () => void navigator.clipboard?.writeText(text).then(() => setStatus('Copied.'), () => setStatus('Could not copy.', true)))
}

/** Sizes the composer to its text once it is in the page. */
export function settleComposer() {
  if (comp?.area.isConnected) autoGrow(comp.area)
}

function submit() {
  const s = selectedSession()
  if (!s || !comp || s.key !== comp.key || !s.canMessage || comp.isFrozen || sendMode(s, isArmed('replies')) !== 'reply' || (state.shell && shellSendBlock(state.shell))) return
  const draft = comp.area.value.trim()
  if (!draft) return
  const send = sendOf(state.send, s.key)
  if (isInFlight(send)) return showComposerError(s.key, BUSY)
  const listed = commandLists.get(s.key)
  const names = listed?.known ? new Set(listed.commands.map(c => c.name)) : null
  const checked = checkReplyText(draft, names)
  const isServerCommand = !checked.ok && checked.reason === 'command' && names === null && parseCommand(draft) !== null
  if (!checked.ok && !isServerCommand) return showComposerError(s.key, checked.error, true)
  const text = checked.ok ? checked.text : draft
  const isCommand = isServerCommand || (checked.ok && checked.command !== undefined)
  comp.area.value = ''
  setDraft(state.drafts, s.key, '')
  showComposerError(s.key, null)
  closeMenu()
  autoGrow(comp.area)
  followChat()
  const question = isCommand ? null : heldQuestion(s)
  if (question) void skipQuestion(s, question, text)
  else void sendReply(s, text)
}

/** Sends a next-step button's label as your reply, through the same checks as typing it; a draft in progress is kept. */
export function sendChoice(key, text) {
  const s = selectedSession()
  if (!s || s.key !== key || !comp || comp.key !== key) return
  const draft = comp.area.value
  comp.area.value = text
  submit()
  const wasSent = comp.area.value === ''
  comp.area.value = draft
  setDraft(state.drafts, key, draft)
  autoGrow(comp.area)
  if (!wasSent) comp.area.focus()
}

/**
 * Sends `text` (a skill's slash line) through the composer's own checks, keeping any draft.
 * Answers null when it went, else why it did not.
 * @param {string} key
 * @param {string} text
 * @returns {string | null}
 */
export function sendLine(key, text) {
  const s = selectedSession()
  if (!s || s.key !== key || !comp || comp.key !== key) return 'This session is no longer selected.'
  if (!s.canMessage) return readOnlyText(s)
  const paused = state.shell ? shellSendBlock(state.shell) : null
  if (paused) return paused.text
  const block = sendBlock(sendMode(s, isArmed('replies')))
  if (block) return block.text
  if (comp.isFrozen) return 'This session cannot take a message right now.'
  const draft = comp.area.value
  const before = composerError
  comp.area.value = text
  submit()
  const wasSent = comp.area.value === ''
  comp.area.value = draft
  setDraft(state.drafts, key, draft)
  autoGrow(comp.area)
  if (wasSent) return null
  const why = composerError?.key === key && composerError !== before ? composerError.text : null
  showComposerError(key, before?.key === key ? before.text : null, before?.isInvalid)
  return why ?? 'Could not send.'
}

async function skipQuestion(s, question, text) {
  const sent = await dismissQuestion(question, text)
  if (sent.ok) return setStatus('Question skipped: Claude reads your message instead.')
  putBack(s.key, text)
  if (sent.outcome) return showComposerError(s.key, 'The question ended before your message went. Your text is back in the box: send it again as a reply.')
  showComposerError(s.key, sent.error ?? 'Could not send.')
}

function putBack(key, text) {
  const current = comp?.key === key ? comp.area.value : draftOf(state.drafts, key)
  const next = current.trim() ? `${text}\n\n${current}` : text
  setDraft(state.drafts, key, next)
  if (comp?.key === key) {
    comp.area.value = next
    autoGrow(comp.area)
  }
}

function bubbleButton(focus, label, onclick, cls = 'ghost small') {
  return el('button', { class: cls, 'data-focus': focus, onclick }, label)
}

/** The message just sent, at the end of the chat with its delivery state and choices; null once the transcript shows it, or when there is none. */
export function pendingBubble(s, rows) {
  const send = chatBubble(sendOf(state.send, s.key), rows, Date.now())
  if (!send) return null
  const text = send.draft
  const isBad = send.status === 'failed' || send.status === 'unknown'
  const actions = []
  if (send.status === 'waiting') {
    actions.push(
      bubbleButton('keep', 'Keep waiting', () => keepWaiting(s, send)),
      bubbleButton('withdraw', 'Withdraw and edit', () => void withdraw(s, send)),
    )
  } else if (send.status === 'held') {
    actions.push(
      send.command ? null : bubbleButton('wait', send.wait ? 'Send after this step' : 'Wait until done', () => void toggleWait(s, send)),
      bubbleButton('withdraw', 'Edit', () => void withdraw(s, send)),
    )
  } else if (send.status === 'expired') {
    actions.push(bubbleButton('withdraw', 'Edit', () => void withdraw(s, send)))
  } else if (send.status === 'unknown') {
    actions.push(copyButton(text), textButton('Dismiss', () => setSend(null, 'area'), { class: 'ghost small', 'data-focus': 'dismiss' }))
  } else if (isBad && send.message === REPLY_OLDER_TEXT) {
    actions.push(
      copyButton(text),
      s.canOpen ? bubbleButton('open', 'Open in Claude', () => void openSession(s)) : null,
      textButton('Dismiss', () => setSend(null, 'area'), { class: 'ghost small', 'data-focus': 'dismiss' }),
    )
  } else if (isBad) {
    actions.push(
      bubbleButton('edit', 'Edit', () => (putBack(s.key, text), setSend(null, 'area'))),
      textButton('Dismiss', () => setSend(null, 'area'), { class: 'ghost small', 'data-focus': 'dismiss' }),
    )
  }
  return el(
    'div',
    { class: `msg you pending${isBad ? ' failed' : ''}` },
    isAwaitingAgent(send.status) ? barSpinner('send-spinner') : null,
    el('span', { class: 'sr-only' }, 'You said:'),
    state.showConvo ? el('div', { class: 'msg-text plain' }, text) : el('div', { class: 'msg-text note' }, 'Message text hidden'),
    send.message === '' && actions.length === 0 ? null : el('div', { class: 'send-actions' }, el('span', { class: isBad ? 'err' : 'note', tabindex: '-1', 'data-focus': 'status', title: send.reason }, send.message ?? 'Sending…'), ...actions),
  )
}

function showSend(key, next, focus = null) {
  if (state.selected === `s:${key}`) {
    setSend(next, focus)
    return
  }
  state.send = sendUpdate(state.send, key, next, false)
  if (next.status === 'sending') return announce(next)
  const title = state.lookup?.sessions.get(key)?.title ?? 'a session'
  setStatus(`${truncate(title, 40)}: ${next.message ?? ''}`, next.status === 'failed' || next.status === 'unknown', { label: 'Show', run: () => select(key) })
}

function sendBase(s, text, sentAt) {
  return { key: s.key, draft: text, sentAt }
}

async function sendReply(s, text) {
  const base = sendBase(s, text, Date.now())
  showSend(s.key, { ...base, status: 'sending', message: 'Sending as you…' })
  let queued
  try {
    queued = await api('POST', '/api/reply', { sessionKey: s.key, text })
  } catch (error) {
    const refused = replyRefusal(error.status, error.detail)
    if (refused) showSend(s.key, { ...base, status: 'failed', message: refused.text, settledAt: Date.now() })
    else showSend(s.key, { ...base, status: 'failed', message: isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : error.message, settledAt: Date.now() })
    return
  }
  await watchReply(s, base, queued.id, Number(queued.createdAt) || Date.now())
}

function keepWaiting(s, send) {
  const watch = watches.get(send.replyId)
  if (watch) watch.fastUntil = Date.now() + FAST_WAIT_MS
  showSend(s.key, { ...send, status: 'sending', message: WAITING_FOR_SESSION }, 'status')
}

async function watchReply(s, sent, id, createdAt) {
  const watch = { fastUntil: Date.now() + FAST_WAIT_MS }
  watches.set(id, watch)
  const base = { ...sent, replyId: id, createdAt }
  const text = sent.draft
  showSend(s.key, { ...base, status: 'sending', message: WAITING_FOR_SESSION })
  let isShowingWait = false
  let held = null
  try {
    while (watches.get(id) === watch) {
      const now = Date.now()
      if (now >= replyDeadline(createdAt, held !== null)) {
        watches.delete(id)
        showSend(s.key, { ...base, status: 'expired', message: EXPIRED })
        return
      }
      if (held) {
        isShowingWait = false
      } else if (now >= watch.fastUntil && !isShowingWait) {
        isShowingWait = true
        showSend(s.key, { ...base, status: 'waiting', message: WAITING })
      } else if (now < watch.fastUntil) isShowingWait = false
      await new Promise(r => setTimeout(r, now < watch.fastUntil ? FAST_POLL_MS : SLOW_POLL_MS))
      if (watches.get(id) !== watch) return
      let result = null
      try {
        result = await api('GET', `/api/reply/${id}`)
      } catch (error) {
        if (pollErrorStep(error.status ?? 0, Date.now(), replyDeadline(createdAt, held !== null)) === 'retry') continue
        throw error
      }
      if (watches.get(id) !== watch) return
      if (result.status === 'held') {
        const wait = result.wait === true
        if (held?.wait !== wait) {
          held = { wait }
          const command = result.command === true
          showSend(s.key, { ...base, status: 'held', wait, ...(command ? { command } : {}), message: command ? COMMAND_HELD : heldText(wait) })
        }
        continue
      }
      if (result.status !== 'pending') {
        watches.delete(id)
        showSend(s.key, { ...base, ...sendAfterAck(s.key, result, text, s.publisher?.modVersion ?? null), draft: text, settledAt: Date.now() })
        return
      }
    }
  } catch (error) {
    if (watches.get(id) !== watch) return
    watches.delete(id)
    showSend(s.key, { ...base, status: 'unknown', message: MAYBE, reason: error.message, settledAt: Date.now() })
  }
}

async function toggleWait(s, send) {
  const wait = !send.wait
  try {
    await api('POST', `/api/reply/${send.replyId}/wait`, { wait })
  } catch (error) {
    setStatus(error.message, true)
    return
  }
  showSend(s.key, { ...send, wait, message: heldText(wait) }, 'wait')
}

async function withdraw(s, send) {
  watches.delete(send.replyId)
  const text = send.draft
  showSend(s.key, { ...send, status: 'sending', message: 'Withdrawing…' }, 'status')
  let answer = null
  let errorStatus = null
  try {
    answer = await api('POST', `/api/reply/${send.replyId}/withdraw`)
  } catch (error) {
    errorStatus = error.status ?? 0
  }
  const outcome = withdrawOutcome(answer, errorStatus)
  if (outcome === 'delivered') {
    showSend(s.key, { ...send, ...sendAfterAck(s.key, answer, text, s.publisher?.modVersion ?? null), draft: text, settledAt: Date.now() })
  } else if (outcome === 'unknown') {
    showSend(s.key, { ...send, status: 'unknown', message: MAYBE, settledAt: Date.now() })
  } else {
    putBack(s.key, text)
    if (state.selected === `s:${s.key}`) setSend(null, 'area')
    else state.send = sendUpdate(state.send, s.key, null, false)
  }
}

/** `r`: puts the cursor in the selected session's composer. */
export function focusReply() {
  const s = selectedSession()
  if (!s) return setStatus('Select a session first.')
  if (!s.canMessage) return setStatus(readOnlyText(s))
  const paused = state.shell ? shellSendBlock(state.shell) : null
  if (paused) return setStatus(paused.text)
  const mode = sendMode(s, isArmed('replies'))
  const block = sendBlock(mode)
  if (block) return setStatus(block.text, false, mode === 'off' ? { label: 'How to turn on', run: openRepliesSetting } : null)
  if (!comp || comp.key !== s.key || !comp.area.isConnected) renderDetail()
  comp?.area.focus()
}
