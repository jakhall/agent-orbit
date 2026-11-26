import { isUrgent } from '/shared/filters.js'
import { clockTime, plural, truncate } from '/shared/format.js'
import { parseMarkdown } from '/shared/markdown.js'
import { chatBubble, chatMarks, chatRowId, linkParts, nextStepLast, withoutOpenQuestion, pruneById, rowCacheKey, isConversationWanted, isReplyWanted, liveAnswerFits, liveFrom, mergeLive, mergeOlder, pinnedPrompt, promptCount, replyQuote, taskList } from '/shared/popout.js'
import { approvalBlock, holdEndedCard, openQuestionText } from './requests.js'
import { $, api, el, hooks, patchChildren, selectedSession, state } from './ctx.js'
import { composerArea, pendingBubble, sendChoice, settleComposer, updateComposer } from './composer.js'
import { icon } from './icons.js'

const setStatus = (text, isBad = false) => hooks.status(text, isBad)
const textButton = (label, onclick, attrs = {}) => el('button', { ...attrs, onclick }, label)

const CONVO_SESSIONS = 12
const CONVO_DEBOUNCE_MS = 150
const RETRY_AFTER_MS = 1_000
const AT_END_PX = 24
const OLDER_PX = 200
const JUMP_GAP_PX = 12
const FLASH_MS = 1_600
const PIN_TEXT_MAX = 300
const PIN_TWO_LINES_PX = 200
const PIN_ENABLED = false
const PIN_MIN_LIST_PX = 80
const SQUEEZED_LIST_PX = 60
let convoTimer = 0
let convoAbort = null
let olderAbort = null
let pane = null
const convoExpanded = new Set()
const promptOf = new WeakMap()

/** Stops a pending refresh and any page request (the selection is changing). */
export function cancelConversationRefresh() {
  clearTimeout(convoTimer)
  olderAbort?.abort()
}

function conversationWanted(s) {
  return isConversationWanted(s, state.showConvo)
}

function keep(key, entry) {
  state.convo.delete(key)
  state.convo.set(key, entry)
  while (state.convo.size > CONVO_SESSIONS) state.convo.delete(state.convo.keys().next().value)
  pruneById(convoExpanded, id => state.convo.has(id.slice(0, id.indexOf('|'))))
}

function conversationRoute(key, extra = '') {
  return `/api/conversation?key=${encodeURIComponent(key)}${extra}`
}

function resetConversation(key) {
  olderAbort?.abort()
  state.convo.delete(key)
  if (pane?.key === key) {
    pane.forceBottom = true
    pane.newCount = 0
  }
  paintChat(key)
  const latest = selectedSession()
  if (latest?.key === key && conversationWanted(latest)) void loadConversation(latest, true)
}

async function loadConversation(s, force = false, isRetry = false, isManual = false) {
  const key = s.key
  const current = state.convo.get(key)
  if (!conversationWanted(s) || current?.status === 'loading' || (!force && current && (current.detached || current.activityAt === s.lastActivityAt))) return
  clearTimeout(convoTimer)
  convoAbort?.abort()
  const abort = new AbortController()
  convoAbort = abort
  const activityAt = s.lastActivityAt
  const from = current?.rows && current.fid && !current.detached ? liveFrom(current.rows) : null
  keep(key, { rows: null, fid: null, start: 0, isStart: false, detached: false, older: 'idle', error: null, ...current, status: 'loading', activityAt })
  const restore = () => {
    const latest = state.convo.get(key)
    if (latest && current) keep(key, { ...latest, status: current.status, activityAt: current.activityAt })
    else if (latest) state.convo.delete(key)
  }
  let data
  try {
    data = await api('GET', conversationRoute(key, `${from === null ? '' : `&from=${from}&fid=${encodeURIComponent(current.fid)}`}${isManual ? '&retry=1' : ''}`), undefined, abort.signal)
  } catch (error) {
    if (convoAbort === abort) convoAbort = null
    if (abort.signal.aborted) {
      restore()
      return
    }
    if (error.status === 409) {
      resetConversation(key)
      return
    }
    if (error.status === 503 && !isRetry) {
      restore()
      setTimeout(() => {
        const latest = selectedSession()
        if (latest?.key === key && conversationWanted(latest)) void loadConversation(latest, true, true)
      }, RETRY_AFTER_MS)
      return
    }
    const latest = state.convo.get(key)
    if (!latest) return
    const isMissing = error.status === 404
    keep(key, { ...latest, status: 'error', rows: isMissing ? null : latest.rows, error: isMissing ? error.message : 'Couldn’t load the conversation.', activityAt })
    paintChat(key)
    return
  }
  if (convoAbort === abort) convoAbort = null
  const latest = state.convo.get(key)
  if (!latest) return
  const rows = Array.isArray(data.rows) ? data.rows : []
  const page = { fid: typeof data.fid === 'string' ? data.fid : null, status: 'ok', error: null, activityAt }
  if (pane?.key === key) measureChat()
  const isReading = pane?.key === key && !pane.atBottom && !pane.forceBottom
  if (from !== null && data.reset === true && isReading && latest.rows) {
    keep(key, { ...latest, ...page, detached: true })
  } else if (from === null || data.reset === true) {
    keep(key, { ...latest, ...page, rows, start: Number(data.start) || 0, isStart: data.isStart === true, detached: false, older: 'idle' })
    if (pane?.key === key) {
      pane.forceBottom = true
      pane.newCount = 0
    }
  } else if (!liveAnswerFits(latest.rows, latest.detached, from)) {
    keep(key, { ...latest, ...page, detached: true })
  } else {
    const merged = mergeLive(latest.rows ?? [], rows, from)
    keep(key, { ...latest, ...page, rows: merged.rows, start: merged.dropped ? (merged.rows[0]?.o ?? latest.start) : latest.start, isStart: merged.dropped ? false : latest.isStart })
    if (isReading) pane.newCount += merged.added
  }
  paintChat(key)
  const next = selectedSession()
  if (next?.key === key && next.lastActivityAt !== activityAt && conversationWanted(next)) void loadConversation(next)
}

async function loadOlder(key, isRetry = false) {
  const c = state.convo.get(key)
  if (!state.showConvo || !c?.rows || !c.fid || c.isStart || c.older === 'loading' || (c.older === 'error' && !isRetry)) return
  olderAbort?.abort()
  const abort = new AbortController()
  olderAbort = abort
  keep(key, { ...c, older: 'loading' })
  paintChat(key)
  try {
    const data = await api('GET', conversationRoute(key, `&before=${c.start}&fid=${encodeURIComponent(c.fid)}`), undefined, abort.signal)
    const latest = state.convo.get(key)
    if (!latest?.rows || latest.fid !== c.fid || latest.start !== c.start) {
      if (latest?.older === 'loading') keep(key, { ...latest, older: 'idle' })
      paintChat(key)
      return
    }
    const start = Number(data.start)
    const isStart = data.isStart === true
    if (!isStart && !(start < c.start)) {
      keep(key, { ...latest, older: 'error' })
    } else {
      const merged = mergeOlder(latest.rows, Array.isArray(data.rows) ? data.rows : [])
      keep(key, { ...latest, rows: merged.rows, start, isStart, older: 'idle', detached: latest.detached || merged.dropped > 0 })
    }
  } catch (error) {
    const latest = state.convo.get(key)
    if (abort.signal.aborted) {
      if (latest?.older === 'loading') keep(key, { ...latest, older: 'idle' })
      return
    }
    if (error.status === 409) {
      resetConversation(key)
      return
    }
    if (latest) keep(key, { ...latest, older: 'error' })
  } finally {
    if (olderAbort === abort) olderAbort = null
  }
  paintChat(key)
}

/** The server saw the open session's transcript written (E-110): fetch its newest messages now instead of waiting for the snapshot. */
export function followConversation(key) {
  const s = selectedSession()
  if (s?.key !== key || !conversationWanted(s)) return
  clearTimeout(convoTimer)
  void loadConversation(s)
}

/** Fetches the selected session's newest messages when its activity moved (debounced), and keeps the chat's live parts current. */
export function refreshConversation() {
  const s = selectedSession()
  if (s && pane?.key === s.key && pane.root.isConnected) {
    paintWorking(s)
    updateComposer(s)
  }
  if (!s || !conversationWanted(s)) return
  const current = state.convo.get(s.key)
  if (current && (current.status === 'loading' || current.activityAt === s.lastActivityAt)) return
  clearTimeout(convoTimer)
  convoTimer = setTimeout(() => {
    const latest = selectedSession()
    if (latest?.key === s.key && conversationWanted(latest)) void loadConversation(latest)
  }, CONVO_DEBOUNCE_MS)
}

/** Scrolls the chat to its newest message and keeps it there (after you send). */
export function followChat() {
  if (!pane) return
  pane.atBottom = true
  pane.forceBottom = true
  pane.newCount = 0
  if (pane.list.isConnected) pane.list.scrollTop = pane.list.scrollHeight
  if (pane.list.isConnected && pane.list.clientHeight > 0) pane.forceBottom = false
  paintNew()
}

function jumpToLatest() {
  const s = selectedSession()
  const c = s ? state.convo.get(s.key) : null
  followChat()
  if (s && c?.detached && conversationWanted(s)) void loadConversation(s, true)
  pane?.list.focus({ preventScroll: true })
}

function buildPane(s) {
  const p = { key: s.key, atBottom: true, forceBottom: false, top: 0, newCount: 0, nodes: new Map(), measured: new WeakSet(), width: 0, bubbleSig: null, notesSig: null, notesNodes: [], topLineSig: null, topLineNodes: [], working: null, pinned: null, pinFrame: 0 }
  p.count = el('span', { class: 'h-count' })
  p.head = el('div', { class: 'chat-head' }, icon('turns', 'accent'), el('h3', { class: 'h-title', id: 'chat-title' }, 'Conversation'), p.count)
  p.hiddenNote = el(
    'p',
    { class: 'chat-hidden-note note', hidden: true },
    'Conversation text is off in this window.',
  )
  p.announce = el('span', { class: 'sr-only', role: 'status' })
  p.topLine = el('div', { class: 'chat-top', role: 'status' })
  p.rows = el('div', { class: 'chat-rows' })
  p.pending = el('div', { class: 'chat-pending' })
  p.workingLine = el('div', { class: 'chat-working', role: 'status' })
  p.question = el('div', { class: 'chat-question cx-requests' })
  p.list = el('div', { class: 'chat-list', tabindex: '0', role: 'region', 'aria-label': 'Messages, newest last' }, p.topLine, p.rows, p.question, p.pending, p.workingLine)
  p.newText = el('span', {})
  p.newBtn = el('button', { class: 'chat-new small', hidden: true, onclick: jumpToLatest }, p.newText)
  p.pinText = el('span', { class: 'chat-pin-text' })
  p.pin = el('button', { class: 'chat-pin', type: 'button', hidden: true, onclick: jumpToPrompt }, p.pinText)
  p.slot = el('div', { class: 'chat-slot' })
  p.compose = el('div', { class: 'chat-compose' })
  p.body = el('div', { class: 'chat-body' }, p.pin, p.list, p.newBtn)
  p.requests = el('div', { class: 'cx-requests' })
  p.root = el('section', { id: 'chat-pane', class: 'chat', 'aria-labelledby': 'chat-title' }, p.head, p.hiddenNote, p.body, p.announce, p.slot, p.compose)
  if (typeof ResizeObserver === 'function') {
    const resized = new ResizeObserver(() => {
      if (pane === p) schedulePin(p)
    })
    resized.observe(p.list)
    resized.observe(p.slot)
  }
  p.list.addEventListener(
    'scroll',
    () => {
      if (pane !== p) return
      measureChat()
      if (p.atBottom && p.newCount) {
        p.newCount = 0
        paintNew()
      }
      maybeLoadOlder()
      schedulePin(p)
    },
    { passive: true },
  )
  return p
}

function schedulePin(p) {
  if (p.pinFrame) return
  p.pinFrame = requestAnimationFrame(() => {
    p.pinFrame = 0
    if (pane === p) updatePin()
  })
}

function hidePin(p) {
  p.pinned = null
  p.pin.hidden = true
}

function updatePin() {
  const p = pane
  if (!p) return
  const height = p.list.isConnected ? p.list.clientHeight : 0
  placePin(p, height)
  p.body.classList.toggle('squeezed', height > 0 && height < SQUEEZED_LIST_PX)
}

function placePin(p, height) {
  const list = p.list
  if (!PIN_ENABLED || !state.showConvo || height < PIN_MIN_LIST_PX) return hidePin(p)
  const nodes = [...p.rows.querySelectorAll(':scope > .msg.you')]
  const top = list.getBoundingClientRect().top
  const index = pinnedPrompt(
    nodes.map(node => {
      const box = node.getBoundingClientRect()
      return { top: box.top - top, bottom: box.bottom - top }
    }),
  )
  const node = index === null ? null : nodes[index]
  const r = node ? promptOf.get(node) : null
  if (!node || !r) return hidePin(p)
  p.pin.style.right = `${list.offsetWidth - list.clientWidth}px`
  p.pin.classList.toggle('one-line', height < PIN_TWO_LINES_PX)
  if (p.pinned === node && !p.pin.hidden) return
  p.pinned = node
  const text = r.text.replace(/\s+/g, ' ').trim()
  const time = r.at ? clockTime(r.at).slice(11) : ''
  p.pinText.textContent = truncate(text, PIN_TEXT_MAX)
  p.pin.title = time ? `Your prompt at ${time}: go to it` : 'Your prompt: go to it'
  p.pin.setAttribute('aria-label', `Go to your prompt${time ? ` at ${time}` : ''}: ${truncate(text, 120)}`)
  p.pin.hidden = false
}

function jumpToPrompt() {
  const p = pane
  const node = p?.pinned
  if (!node?.isConnected) return
  const list = p.list
  list.scrollTop += node.getBoundingClientRect().top - list.getBoundingClientRect().top - JUMP_GAP_PX
  measureChat()
  node.setAttribute('tabindex', '-1')
  node.focus({ preventScroll: true })
  node.classList.remove('flash')
  void node.offsetWidth
  node.classList.add('flash')
  setTimeout(() => node.classList.remove('flash'), FLASH_MS)
  updatePin()
}

/**
 * The panel's chat for a session (messages, the needs-you callout and the
 * composer) and its request card, pinned at the panel's top. Both are kept
 * across redraws, so focus, caret and reading position survive.
 */
export function chatPane(s) {
  if (!pane || pane.key !== s.key) pane = buildPane(s)
  pane.root.classList.toggle('text-off', !state.showConvo)
  pane.hiddenNote.hidden = state.showConvo
  const requestsTop = pane.requests.scrollTop
  const block = approvalBlock(s)
  const isQuestion = Boolean(block?.classList.contains('question-card'))
  const shownQuestion = pane.question.firstElementChild
  if (!holdEndedCard(pane.question, isQuestion ? block : null)) patchChildren(pane.question, isQuestion ? [block] : [])
  pane.openQuestion = isQuestion ? openQuestionText(s) : null
  patchChildren(pane.requests, block && !isQuestion ? [block] : [])
  pane.requests.scrollTop = requestsTop
  if (isQuestion && block !== shownQuestion) pane.forceBottom = true
  patchChildren(pane.slot, isQuestion ? [] : [needsCallout(s)])
  patchChildren(pane.compose, composerArea(s))
  paintHead(s)
  paintList(s)
  paintWorking(s)
  paintNew()
  return { chat: pane.root, requests: pane.requests }
}

/** Puts the chat's scroll back after it was (re)attached: at the newest message, or where you were reading. */
export function restoreChatScroll() {
  if (!pane?.list.isConnected) return
  settleComposer()
  measureRows()
  pane.list.scrollTop = pane.atBottom || pane.forceBottom ? pane.list.scrollHeight : pane.top
  pane.forceBottom = false
  maybeLoadOlder()
  updatePin()
}

/**
 * Notes where the chat is scrolled (scroll events do not fire while the
 * window is not drawn), before anything redraws or resizes it.
 */
export function measureChat() {
  const list = pane?.list
  if (!list?.isConnected || list.clientHeight === 0 || pane.forceBottom) return
  pane.top = list.scrollTop
  pane.atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= AT_END_PX
}

/** Keeps the newest message in view after the chat's size changed, and re-checks which rows need Show more at a new width. */
export function stickChat() {
  if (!pane?.list.isConnected) return
  if (pane.list.clientWidth !== pane.width) measureRows()
  if (pane.atBottom) pane.list.scrollTop = pane.list.scrollHeight
  updatePin()
}

function paintChat(key) {
  if (state.selected !== `s:${key}` || pane?.key !== key) return
  const s = state.lookup?.sessions.get(key)
  if (!s) return
  paintHead(s)
  paintList(s)
  paintNew()
  $('needs-ctx')?.replaceWith(needsCallout(s))
}

function paintHead(s) {
  const c = state.showConvo ? state.convo.get(s.key) : null
  const count = c?.rows ? promptCount(c.rows, c.isStart && !c.detached) : { text: '', title: '' }
  if (pane.count.textContent !== count.text) pane.count.textContent = count.text
  if (count.title) pane.count.title = count.title
  else pane.count.removeAttribute('title')
}

function paintWorking(s) {
  const detail = s.activity && !/^Working\b/.test(s.activity) ? ` · ${truncate(s.activity, 120)}` : ''
  const text = s.lifecycle === 'running' ? `Claude is working${detail}` : ''
  if (pane.working === text) return
  pane.working = text
  pane.workingLine.replaceChildren(...(text ? [el('span', { class: 'work-dot', 'aria-hidden': 'true' }), el('span', {}, text)] : []))
}

function paintNew() {
  if (!pane) return
  const c = state.convo.get(pane.key)
  const isDetached = Boolean(c?.detached && c.rows)
  const text = !state.showConvo ? '' : isDetached ? 'Jump to latest' : pane.newCount ? `${plural(pane.newCount, 'new message')}` : ''
  const wasShown = !pane.newBtn.hidden
  pane.newBtn.hidden = !text
  pane.body.classList.toggle('has-new', Boolean(text))
  if (pane.newText.textContent !== text) pane.newText.textContent = text
  if (text && !wasShown) pane.announce.textContent = text
  else if (!text) pane.announce.textContent = ''
  pane.newBtn.title = isDetached ? 'Earlier pages pushed the newest messages out: load them again' : 'Scroll to the newest message'
}

function memo(sig, key, build) {
  if (pane[`${key}Sig`] === sig) return pane[`${key}Nodes`]
  pane[`${key}Sig`] = sig
  pane[`${key}Nodes`] = build()
  return pane[`${key}Nodes`]
}

function topLine(key, c) {
  const sig = !c?.rows || !state.showConvo ? '' : c.older === 'loading' ? 'loading' : c.older === 'error' ? 'error' : c.isStart ? 'start' : ''
  return memo(sig, 'topLine', () => {
    if (sig === 'loading') return [el('p', { class: 'note' }, 'Loading earlier messages…')]
    if (sig === 'start') return [el('p', { class: 'note' }, 'Start of this conversation')]
    if (sig === 'error') return [el('div', { class: 'convo-error' }, el('span', { class: 'note' }, 'Couldn’t load earlier messages.'), textButton('Retry', () => void loadOlder(key, true), { class: 'ghost small' }))]
    return []
  })
}

function noteRows(s, c) {
  const error = c?.status === 'error' ? c.error : null
  const sig = !state.showConvo ? 'hidden' : !c?.rows ? `none|${error ?? ''}` : c.rows.length === 0 ? `empty|${c.isStart}|${error ?? ''}` : `rows|${error ?? ''}`
  return memo(sig, 'notes', () => {
    const retry = () => textButton('Retry', () => void loadConversation(state.lookup?.sessions.get(s.key) ?? s, true, false, true), { class: 'ghost small' })
    if (!state.showConvo) return []
    if (!c?.rows) return error ? [el('div', { class: 'convo-error' }, el('span', { class: 'note' }, error), retry())] : [el('p', { class: 'note' }, 'Loading…')]
    const extra = error ? [el('div', { class: 'convo-error' }, el('span', { class: 'note' }, error), retry())] : []
    if (c.rows.length === 0) return [el('p', { class: 'note' }, c.isStart ? 'No messages yet.' : 'No messages near the end of this transcript.'), ...extra]
    return extra
  })
}

const TASK_STATUS_WORDS = { completed: 'Done: ', in_progress: 'In progress: ', pending: 'To do: ' }

function taskRows(rows, running) {
  const steps = running ? taskList(rows) : null
  const sig = steps ? JSON.stringify(steps) : ''
  return memo(sig, 'tasks', () => {
    if (!steps) return []
    const items = steps.map(step =>
      el(
        'li',
        { class: `task ${step.status.replace('_', '-')}` },
        el('span', { class: 'task-box', 'aria-hidden': 'true' }, step.status === 'completed' ? icon('done') : null),
        el('span', { class: 'sr-only' }, TASK_STATUS_WORDS[step.status]),
        el('span', { class: 'task-text' }, step.content),
      ),
    )
    return [el('ul', { class: 'chat-tasks', 'aria-label': 'Task list' }, ...items)]
  })
}

function anchorOf(list) {
  const top = list.getBoundingClientRect().top
  for (const node of list.querySelectorAll('.chat-rows > .msg')) {
    const box = node.getBoundingClientRect()
    if (box.bottom > top) return { node, offset: box.top - top }
  }
  return null
}

function sameChildren(parent, nodes) {
  if (parent.childNodes.length !== nodes.length) return false
  return nodes.every((node, i) => parent.childNodes[i] === node)
}

function paintList(s) {
  const p = pane
  const c = state.convo.get(s.key)
  const held = state.showConvo ? (c?.rows ?? null) : null
  const rows = held ? nextStepLast(withoutOpenQuestion(held, p.openQuestion ?? null).filter(r => r.who !== 'plan')) : null
  const list = p.list
  const isLive = list.isConnected && list.clientHeight > 0
  measureChat()
  const anchor = isLive && !p.atBottom && !p.forceBottom ? anchorOf(list) : null
  const nodes = new Map()
  const marks = rows ? chatMarks(rows, Date.now()) : []
  const latestFrom = rows ? rows.findLastIndex(r => r.who === 'you') + 1 : 0
  const rowNodes = (rows ?? []).flatMap((r, i) => {
    const mark = marks[i] ?? { day: null, head: true, turn: true }
    const id = rowCacheKey(r, i, mark)
    const node = p.nodes.get(id) ?? messageRow(s.key, r, mark)
    nodes.set(id, node)
    const isLatest = i >= latestFrom && (r.who === 'claude' || r.who === 'question')
    if (node.classList.contains('latest') !== isLatest) {
      node.classList.toggle('latest', isLatest)
      p.measured.delete(node)
    }
    if (!mark.day) return [node]
    const dayId = `day|${chatRowId(r, i)}|${mark.day}`
    const divider = p.nodes.get(dayId) ?? el('div', { class: 'chat-day', role: 'separator', 'aria-label': mark.day }, mark.day)
    nodes.set(dayId, divider)
    return [divider, node]
  })
  p.nodes = nodes
  const top = topLine(s.key, c)
  if (!sameChildren(p.topLine, top)) p.topLine.replaceChildren(...top)
  const all = rows && rows.length ? [...rowNodes, ...taskRows(held ?? [], s.lifecycle === 'running'), ...noteRows(s, c)] : noteRows(s, c)
  if (!sameChildren(p.rows, all)) p.rows.replaceChildren(...all)
  paintBubble(s, rows)
  if (!isLive) return hidePin(p)
  measureRows()
  if (p.atBottom || p.forceBottom) {
    list.scrollTop = list.scrollHeight
    p.atBottom = true
    p.forceBottom = false
  } else if (anchor?.node.isConnected) {
    const delta = anchor.node.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset
    if (Math.abs(delta) >= 1) list.scrollTop += delta
  }
  maybeLoadOlder()
  updatePin()
}

function paintBubble(s, rows) {
  const p = pane
  const send = chatBubble(state.send?.key === s.key ? state.send : null, rows, Date.now())
  const sig = send ? JSON.stringify([send.status, send.message, send.draft, send.replyId ?? null, send.route ?? null, state.showConvo]) : ''
  if (sig === p.bubbleSig) return
  p.bubbleSig = sig
  const hadFocus = p.pending.contains(document.activeElement)
  const bubble = send ? pendingBubble(s, rows) : null
  p.pending.replaceChildren(...(bubble ? [bubble] : []))
  if (hadFocus && !p.pending.contains(document.activeElement)) (p.pending.querySelector('[data-focus="status"]') ?? p.compose.querySelector('textarea'))?.focus()
}

function maybeLoadOlder() {
  const p = pane
  if (!p || !state.showConvo || state.selected !== `s:${p.key}` || !p.list.isConnected || p.list.clientHeight === 0 || p.list.scrollTop > OLDER_PX) return
  const c = state.convo.get(p.key)
  if (!c?.rows || c.isStart || c.older !== 'idle' || c.status === 'loading') return
  void loadOlder(p.key)
}

function measureRows() {
  const p = pane
  if (!p?.list.isConnected || p.list.clientWidth === 0) return
  if (p.list.clientWidth !== p.width) {
    p.width = p.list.clientWidth
    p.measured = new WeakSet()
  }
  for (const node of p.rows.children) {
    if (p.measured.has(node)) continue
    const body = node.querySelector('.msg-text.clamped')
    const toggle = node.querySelector('.more-btn')
    if (!toggle) continue
    p.measured.add(node)
    if (!body) continue
    toggle.hidden = body.scrollHeight <= body.clientHeight + 1
    body.classList.toggle('overflows', !toggle.hidden)
  }
}

/** Hands a clicked link to the server for the default browser; the Orbit window's own (Edge) only if that fails. */
function openLink(event, href) {
  if (event.button !== 0) return
  event.preventDefault()
  api('POST', '/api/open-url', { url: href }).catch(() => window.open(href, '_blank', 'noopener,noreferrer'))
}

/** A link shows its host beside its text and opens in the default browser, with no referrer; only http and https become links. */
function linkNodes(text) {
  return linkParts(text).map(part =>
    part.type === 'link'
      ? el('a', { href: part.href, target: '_blank', rel: 'noopener noreferrer', title: part.href, onclick: event => openLink(event, part.href) }, part.text, part.text === part.href ? null : el('span', { class: 'md-host' }, ` (${part.host})`))
      : part.text,
  )
}

function inlineNodes(inline) {
  return inline.flatMap(part => (part.type === 'code' ? [el('code', {}, part.text)] : part.type === 'bold' ? [el('strong', {}, ...linkNodes(part.text))] : part.type === 'italic' ? [el('em', {}, ...linkNodes(part.text))] : linkNodes(part.text)))
}

const COPIED_MS = 1_500

function copyCode(button, text) {
  navigator.clipboard.writeText(text).then(
    () => {
      button.textContent = 'Copied'
      button.title = 'Copied'
      button.setAttribute('aria-label', 'Copied')
      button.classList.add('copied')
      setStatus('Code copied')
      setTimeout(() => {
        button.textContent = 'Copy'
        button.title = 'Copy code'
        button.setAttribute('aria-label', 'Copy code')
        button.classList.remove('copied')
      }, COPIED_MS)
    },
    () => setStatus('Couldn’t copy: the clipboard is not available.', true),
  )
}

function codeBlock(block) {
  const pre = el('pre', { class: 'md-code', tabindex: '0', 'aria-label': block.lang ? `${block.lang} code` : 'Code' }, el('code', {}, block.text))
  if (typeof navigator.clipboard?.writeText !== 'function') return pre
  const button = textButton('Copy', () => copyCode(button, block.text), { class: 'ghost small md-copy', 'aria-label': 'Copy code', title: 'Copy code' })
  return el('div', { class: 'md-code-wrap' }, pre, button)
}

const ALIGN_CLASS = { left: 'al-l', center: 'al-c', right: 'al-r' }

function tableBlock(block) {
  const cell = (tag, inline, i) => el(tag, { class: ALIGN_CLASS[block.align[i]] ?? null, scope: tag === 'th' ? 'col' : null }, ...inlineNodes(inline))
  return el(
    'div',
    { class: 'md-table', tabindex: '0', role: 'region', 'aria-label': 'Table' },
    el('table', {}, el('thead', {}, el('tr', {}, ...block.head.map((inline, i) => cell('th', inline, i)))), block.rows.length ? el('tbody', {}, ...block.rows.map(row => el('tr', {}, ...row.map((inline, i) => cell('td', inline, i))))) : null),
  )
}

function markdownBlock(block) {
  if (block.type === 'code') return codeBlock(block)
  if (block.type === 'table') return tableBlock(block)
  if (block.type === 'heading') return el('p', { class: 'md-h' }, el('strong', {}, ...inlineNodes(block.inline)))
  if (block.type === 'list') {
    return el(
      block.ordered ? 'ol' : 'ul',
      { start: block.ordered && block.start !== 1 ? block.start : null },
      ...block.items.map(item => el('li', { class: item.indent ? 'md-sub' : null }, ...inlineNodes(item.inline))),
    )
  }
  return el('p', {}, ...inlineNodes(block.inline))
}

function messageBody(r) {
  if (r.who === 'you') return el('div', { class: 'msg-text plain' }, r.text)
  return el('div', { class: 'msg-text md' }, ...parseMarkdown(r.text).map(markdownBlock))
}

function rowClass(r, mark) {
  return `msg ${r.who}${r.next ? ' next-step' : ''}${mark.turn ? ' turn' : ''}${(r.who === 'claude' || r.who === 'question') && !mark.head ? ' cont' : ''}`
}

function messageHead(r, mark, time) {
  if (r.who === 'you') return el('span', { class: 'sr-only' }, 'You said:')
  const name = r.who === 'question' ? 'Claude asked' : 'Claude'
  if (!mark.head) return el('span', { class: 'sr-only' }, `${name}:`)
  return el('div', { class: 'msg-head' }, name, time ? el('span', { class: 'msg-at', title: time }, time.slice(11)) : null)
}

export function messageRow(key, r, mark) {
  const time = r.at ? clockTime(r.at) : ''
  if (r.who === 'tools' || r.who === 'event') {
    return el(
      'div',
      { class: rowClass(r, mark), title: time ? `${r.text} · ${time.slice(11)}` : r.text },
      el('span', {}, r.who === 'event' ? el('span', { class: 'sr-only' }, 'Event: ') : null, r.text),
    )
  }
  const id = `${key}|${r.o}:${r.i ?? 0}`
  const isOpen = convoExpanded.has(id)
  const body = messageBody(r)
  body.classList.toggle('clamped', !isOpen)
  if (time && (r.who === 'you' || !mark.head)) body.title = time
  const toggle = el(
    'button',
    {
      class: 'ghost small more-btn',
      hidden: !isOpen,
      'aria-expanded': String(isOpen),
      onclick: event => {
        const isNowOpen = body.classList.toggle('clamped') === false
        if (isNowOpen) convoExpanded.add(id)
        else {
          convoExpanded.delete(id)
          body.classList.add('overflows')
        }
        event.currentTarget.setAttribute('aria-expanded', String(isNowOpen))
        event.currentTarget.textContent = isNowOpen ? 'Show less' : 'Show more'
      },
    },
    isOpen ? 'Show less' : 'Show more',
  )
  const row = el(
    'div',
    { class: rowClass(r, mark) },
    messageHead(r, mark, time),
    body,
    r.choices?.length ? choiceButtons(key, r.choices) : null,
    r.cut ? el('p', { class: 'msg-cut note' }, 'Cut here: open the session for the rest.') : null,
    toggle,
  )
  if (r.who === 'you') promptOf.set(row, r)
  return row
}

/** The desktop next-step box's reply buttons: its pick first and filled; they answer only while the row is Claude's latest. */
function choiceButtons(key, choices) {
  return el(
    'div',
    { class: 'msg-choices', role: 'group', 'aria-label': 'Reply with' },
    ...choices.map((label, i) =>
      el(
        'button',
        {
          type: 'button',
          class: i === 0 ? 'small primary' : 'small',
          title: `Send "${label}"`,
          onclick: event => {
            if (event.currentTarget.closest('.msg')?.classList.contains('latest')) sendChoice(key, label)
          },
        },
        label,
      ),
    ),
  )
}

function quoteFor(s) {
  const rows = isReplyWanted(s) && state.showConvo ? state.convo.get(s.key)?.rows : null
  return rows ? replyQuote(rows) : null
}

function questionElsewhere(s) {
  const open = s.canOpen ? el('button', { class: 'small', title: 'Open in Claude (o)', 'aria-keyshortcuts': 'o', onclick: () => void hooks.openSession(s) }, 'Open in Claude') : null
  return el(
    'div',
    { id: 'needs-ctx', class: 'callout reply q-elsewhere' },
    el('div', { class: 'reply-label' }, el('span', {}, el('strong', {}, 'This question is in Claude.'), ' Orbit takes questions only while its window is in front, so answer it there.'), open),
  )
}

/** What the session needs, just above the composer: one line, since Claude's last message is right above it in the chat. */
export function needsCallout(s) {
  const quote = quoteFor(s)
  if (quote?.who === 'question') return questionElsewhere(s)
  if (quote) return el('div', { id: 'needs-ctx', class: 'callout reply' }, el('div', { class: 'reply-label' }, icon('bolt', 'tip-bolt'), el('span', {}, s.attentionText ?? 'Claude is waiting for you')))
  const text = isUrgent(s) ? s.attentionText : null
  return el('div', { id: 'needs-ctx', class: 'callout quiet needs', hidden: !text }, el('span', {}, el('span', { class: 'sr-only' }, 'Needs you: '), text ?? ''))
}
