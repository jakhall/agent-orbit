import { ago, shortModel, truncate } from '/shared/format.js'
import { errorsText, isNoWindow, NO_WINDOW_TEXT, rowMeta, statusOf } from '/shared/popout.js'
import { sanitizePrefs } from '/shared/prefs.js'
import { failureText } from '/shared/failure.js'
import { projectChoices, SOURCE_TEXT } from '/shared/map.js'
import { icon } from './icons.js'
import { changesSection, refreshChanges } from './changes.js'
import { state as chatState } from './ctx.js'
import { cancelConversationRefresh, chatPane, measureChat, refreshConversation, restoreChatScroll, stickChat } from './chat.js'
import { applySendFocus } from './composer.js'
import { remoteSwitch, remoteSwitchSignature } from './remote-switch.js'
import { editingSignature, isEditing, renameForm, robotIcon, startEditing, stopEditing, tintOf, titleOf } from './identity.js'
import { approvalDrawn } from './requests.js'
import { $, el, post, remember, state, stored } from './page-state.js'
import { reportAttention } from './live.js'
import { renderRail, setRailOpen } from './rail.js'
import { actionButtons, iconButton } from './actions.js'
import { homeFocus, isShown } from './toast.js'
import { focusSelected, invalidateGeometry, renderMap } from './stage.js'
import { hideCard } from './card.js'
import { renderHome } from './convo-view.js'
import { agentOf, closeAgentPanel, LIFECYCLE_BUCKET, LIFECYCLE_TEXT, renderAgentPanel } from './agent-panel.js'
import { closeProjectPanel, projectPanelId, renderProjectPanel } from './project-panel.js'

export function select(key, invoker = null) {
  hideCard()
  if (!isEditing(key)) stopEditing()
  if (state.convo.key !== key) cancelConversationRefresh()
  if (document.querySelector('.cx-body').classList.contains('is-rail-open')) setRailOpen(false)
  state.invoker = invoker
  state.selected = `s:${key}`
  state.focusNode = key
  renderRail()
  renderMap()
  $('cx-rail').querySelector(`.cx-row[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' })
  openPanel(key)
  renderMap()
  focusSelected()
}

/**
 * Puts a whole project in focus on the map: its hexagon in the accent, every
 * session, sub-agent and link under it full, the rest faded. With `open`, shows
 * the project's panel in place of an open one; without, closes an open panel.
 * Esc or a click on empty map ends it.
 * @param {string} projectId the map node id, `p:…`
 * @param {{ open?: boolean, invoker?: Element | null }} [options]
 */
export function focusProject(projectId, { open = false, invoker = null } = {}) {
  hideCard()
  if (!open) {
    if (!$('cx-panel').hidden) closePanel()
    projectShown = null
    state.selected = projectId
    state.focusNode = null
    renderRail()
    renderMap()
    return
  }
  stopEditing()
  cancelConversationRefresh()
  closeAgentPanel()
  if (document.querySelector('.cx-body').classList.contains('is-rail-open')) setRailOpen(false)
  state.invoker = invoker
  state.selected = projectId
  state.focusNode = null
  state.convo = { key: null }
  projectShown = projectId.slice(2)
  syncChat()
  renderPanel()
  renderRail()
  renderMap()
  renderHome()
  focusOpenTitle()
  reportAttention()
}

let projectShown = null

/** The project whose panel is open (its id, without `p:`), or null. */
function openProject() {
  return !state.convo.key && projectShown && state.selected === `p:${projectShown}` ? projectShown : null
}

/** Whether the project panel is showing. */
export function isProjectPanelOpen() {
  return openProject() !== null && projectPanelId() !== null
}

/**
 * Opens one sub-agent's panel: its status, parent, transcript and, while
 * replies are armed, a message box and Stop.
 * @param {string} agentKey `${sessionKey}/${agentId}`
 * @param {Element | null} invoker
 */
export function selectAgent(agentKey, invoker = null) {
  hideCard()
  cancelConversationRefresh()
  const sessionKey = agentKey.slice(0, agentKey.lastIndexOf('/'))
  state.invoker = invoker
  state.selected = `a:${agentKey}`
  state.focusNode = null
  state.convo = { key: sessionKey, agent: agentKey }
  projectShown = null
  closeProjectPanel()
  $('cx-panel').hidden = false
  invalidateGeometry()
  renderPanel()
  renderRail()
  renderMap()
  focusOpenTitle()
  reportAttention()
}

export function closePanel() {
  const key = state.convo.agent ? null : state.convo.key
  state.selected = null
  state.convo = { key: null }
  closeAgentPanel()
  closeProjectPanel()
  projectShown = null
  cancelConversationRefresh()
  syncChat()
  reportAttention()
  $('cx-panel').hidden = true
  document.querySelector('.cx-body').classList.remove('is-details-open')
  invalidateGeometry()
  renderRail()
  renderMap()
  renderHome()
  const rows = key ? [$('cx-rail').querySelector(`.cx-row[data-key="${CSS.escape(key)}"]`)] : []
  const back = [state.invoker, ...rows].find(isShown) ?? null
  ;(back ?? homeFocus()).focus({ preventScroll: true })
  state.invoker = null
}

function openPanel(key) {
  $('cx-panel').hidden = false
  invalidateGeometry()
  state.overrideErrors.clear()
  state.convo = { key }
  renderPanel()
  focusOpenTitle()
  reportAttention()
}

/** Focuses the open session's or sub-agent's title wherever it shows: the details pane, else the Conversation view's header. */
export function focusOpenTitle() {
  ;[$('cx-panel-title'), $('cx-convo-title')].find(n => n && n.getClientRects().length > 0)?.focus({ preventScroll: true })
}

/**
 * Shows or folds the details over the conversation (the Conversation view on
 * a window too narrow for both side by side).
 * @param {boolean} open
 */
export function setDetailsOpen(open) {
  const body = document.querySelector('.cx-body')
  if (body.classList.contains('is-details-open') === open) return
  body.classList.toggle('is-details-open', open)
  for (const button of document.querySelectorAll('.cx-details-toggle')) button.setAttribute('aria-expanded', String(open))
  invalidateGeometry()
  if (open) $('cx-panel-title')?.focus({ preventScroll: true })
  else document.querySelector('.cx-details-toggle')?.focus({ preventScroll: true })
}

function setPanelShown(shown) {
  const panel = $('cx-panel')
  if (panel.hidden === !shown) return
  panel.hidden = !shown
  invalidateGeometry()
}

/** What the chat modules read from the page: the open session, the snapshot, the shell and the text setting. */
function syncChat() {
  chatState.selected = state.convo.key && !state.convo.agent ? `s:${state.convo.key}` : null
  chatState.lookup = state.lookup
  chatState.shell = state.shell
  chatState.showConvo = stored('showConvo', true) !== false
}

export function refreshConvo() {
  renderPanel()
}

/**
 * The panel's slots, each rebuilt only when what it shows changed, so a
 * control in one survives live updates: the header, the request card, the
 * details (facts and, apart, the project row), and the chat.
 */
const slots = { key: null, head: null, requests: null, details: null, summary: null, facts: null, project: null, chat: null, headSig: '', focusEdit: false, factsSig: '', projectSig: '', hasRequest: false, isAutoFolded: false, skipSave: false }

function newSlots(key, panel) {
  slots.key = key
  slots.head = el('div', { class: 'cx-slot' })
  slots.remote = el('span', { class: 'cx-remote-slot' })
  slots.remoteSig = ''
  slots.glance = el('div', { class: 'cx-slot cx-glance-slot' })
  slots.changes = el('div', { class: 'cx-slot' })
  slots.agents = el('div', { class: 'cx-slot' })
  slots.agentsSig = ''
  slots.glanceSig = ''
  slots.requests = el('div', { class: 'cx-slot cx-requests-slot' })
  slots.facts = el('div', { class: 'cx-slot' })
  slots.project = el('div', { class: 'cx-slot' })
  slots.summaryCount = el('span', { class: 'h-count' })
  slots.config = foldSection('configShown', true, { class: 'cx-section cx-config' },
    el('summary', {}, icon('chevron', 'chev'), icon('sliders', 'accent'), el('span', { class: 'h-title' }, 'Configuration'), slots.summaryCount),
    slots.glance, slots.facts, slots.project)
  slots.detailsCount = el('span', { class: 'h-count' })
  slots.summary = el('summary', {}, icon('chevron', 'chev'), icon('info', 'accent'), el('span', { class: 'h-title' }, 'Details'), slots.detailsCount)
  slots.details = el('details', { class: 'cx-details', open: stored('detailsShown', false) === true || null }, slots.summary, slots.config, slots.agents, slots.changes)
  slots.hasRequest = false
  slots.isAutoFolded = false
  slots.details.addEventListener('toggle', () => {
    if (slots.skipSave) return void (slots.skipSave = false)
    slots.isAutoFolded = false
    remember('detailsShown', slots.details.open)
  })
  slots.chat = el('div', { class: 'cx-slot cx-chat-slot' })
  slots.headSig = slots.factsSig = slots.projectSig = ''
  slots.top = el('div', { class: 'cx-panel-top' }, slots.head, slots.details)
  slots.view = state.view
  slots.convoHead = null
  slots.convoHeadSig = ''
  if (state.view === 'conversation') {
    slots.convoHead = el('div', { class: 'cx-slot' })
    panel.replaceChildren(slots.top)
    $('cx-convo').replaceChildren(slots.convoHead, slots.requests, slots.chat)
  } else panel.replaceChildren(slots.top, chatSplitter(panel), slots.requests, slots.chat)
}

/** A sub-section of Details that remembers, per window, whether it is open (`fallback` until it is toggled). */
function foldSection(name, fallback, attrs, ...children) {
  const block = el('details', { ...attrs, open: (stored(name, fallback) === true) || null }, ...children)
  block.addEventListener('toggle', () => remember(name, block.open))
  return block
}

function agentList(keys) {
  return foldSection(
    'agentsShown',
    false,
    { class: 'cx-section cx-agents' },
    el('summary', {}, icon('chevron', 'chev'), icon('agents', 'accent'), el('span', { class: 'h-title' }, 'Sub-agents'), el('span', { class: 'h-count' }, String(keys.length))),
    el(
      'ul',
      { class: 'cx-agents-list' },
      ...keys.map(k => {
        const a = agentOf(k)
        const lifecycle = a?.lifecycle ?? 'unknown'
        return el(
          'li',
          {},
          el(
            'button',
            { class: 'cx-agent-row', type: 'button', 'data-agent': k, onclick: event => selectAgent(k, event.currentTarget) },
            el('span', { class: `dot b-${LIFECYCLE_BUCKET[lifecycle] ?? 'idle'}`, 'aria-hidden': 'true' }),
            el('span', { class: 't' }, truncate(a?.description || a?.name || 'Sub-agent', 80)),
            el('span', { class: 'meta' }, LIFECYCLE_TEXT[lifecycle] ?? 'Unknown'),
          ),
        )
      }),
    ),
  )
}

const projectActions = {
  select: (key, invoker) => select(key, invoker),
  close: () => closePanel(),
  repaint: () => {
    renderRail()
    renderMap()
  },
}

export function renderPanel() {
  const key = state.convo.key
  const panel = $('cx-panel')
  if (!key) {
    const projectId = openProject()
    if (!projectId) return
    slots.key = null
    if (state.view === 'conversation') {
      panel.replaceChildren()
      closeProjectPanel()
      setPanelShown(false)
      return
    }
    setPanelShown(true)
    renderProjectPanel(panel, projectId, projectActions)
    return
  }
  projectShown = null
  closeProjectPanel()
  syncChat()
  const isConvo = state.view === 'conversation'
  if (state.convo.agent) {
    slots.key = null
    if (isConvo) {
      panel.replaceChildren()
      setPanelShown(false)
    }
    renderAgentPanel(isConvo ? $('cx-convo') : panel, state.convo.agent, { select: k => select(k), close: closePanel })
    return
  }
  setPanelShown(true)
  closeAgentPanel()
  measureChat()
  const active = document.activeElement
  const wasInChat = active === document.body || Boolean(document.querySelector('.cx-chat-slot .chat')?.contains(active))
  if (slots.key !== key || slots.view !== state.view || !slots.head?.isConnected || !slots.chat?.isConnected) newSlots(key, panel)
  const s = state.lookup?.sessions.get(key)
  const st = s ? statusOf(s) : null
  const failure = s?.failure?.isCurrent ? failureText(s.failure.category) : null
  const ask = s?.lastReport?.ask && s.lastReport.ask !== st?.reason ? s.lastReport.ask : null
  const isRenaming = Boolean(s) && isEditing(key)
  const headSig = isRenaming ? editingSignature() : JSON.stringify([s ? titleOf(s) : null, s ? tintOf(s) : null, st?.reason, st?.bucket, st?.since, s?.canOpen, ask, failure])
  if (headSig !== slots.headSig) {
    const titleHadFocus = document.activeElement?.id === 'cx-panel-title'
    const closeHadFocus = document.activeElement?.classList.contains('cx-close')
    const editHadFocus = document.activeElement?.classList.contains('cx-edit') || slots.focusEdit
    slots.focusEdit = false
    slots.headSig = headSig
    const renamed = focusEdit => {
      slots.headSig = null
      slots.focusEdit = focusEdit
      renderPanel()
    }
    slots.head.replaceChildren(
      el(
        'header',
        { class: 'cx-panel-head' },
        isRenaming
          ? el('div', {}, renameForm(s, { done: renamed }))
          : el(
              'div',
              {},
              el('h2', { id: 'cx-panel-title', tabindex: '-1' }, s ? [robotIcon(s), el('span', {}, titleOf(s))] : 'Session'),
              st ? statusLine(st, failure && failure !== st.reason ? `Failed: ${failure}` : ask ? `Asks you: ${ask}` : '') : null,
            ),
        s && !isRenaming ? iconButton('edit', 'Rename or change its colour', () => (startEditing(s), renamed(false)), { class: 'ghost cx-edit' }) : null,
        iconButton('close', 'Close (Esc)', closePanel, { class: 'ghost cx-close' }),
      ),
      ...(s ? [actionButtons(key)] : []),
    )
    slots.head.querySelector('.cx-actions')?.append(slots.remote)
    if (closeHadFocus) panel.querySelector('.cx-close')?.focus({ preventScroll: true })
    else if (editHadFocus && !isRenaming) panel.querySelector('.cx-edit')?.focus({ preventScroll: true })
    else if (titleHadFocus) $('cx-panel-title')?.focus({ preventScroll: true })
  }
  if (slots.convoHead) {
    const isOpen = document.querySelector('.cx-body').classList.contains('is-details-open')
    const convoHeadSig = JSON.stringify([s ? titleOf(s) : null, s ? tintOf(s) : null, st?.bucket, isOpen])
    if (convoHeadSig !== slots.convoHeadSig) {
      const hadFocus = slots.convoHead.contains(document.activeElement) ? (document.activeElement.id || 'toggle') : null
      slots.convoHeadSig = convoHeadSig
      slots.convoHead.replaceChildren(
        el(
          'header',
          { class: 'cx-convo-head' },
          st ? el('span', { class: `dot b-${st.bucket}`, 'aria-hidden': 'true' }) : null,
          s ? robotIcon(s) : null,
          el('h2', { id: 'cx-convo-title', tabindex: '-1' }, s ? titleOf(s) : 'Session'),
          iconButton('info', isOpen ? 'Hide details' : 'Show details', () => setDetailsOpen(!document.querySelector('.cx-body').classList.contains('is-details-open')), { class: 'ghost cx-details-toggle', 'aria-expanded': String(isOpen), 'aria-controls': 'cx-panel' }),
          iconButton('close', 'Close (Esc)', closePanel, { class: 'ghost cx-convo-close' }),
        ),
      )
      if (hadFocus === 'cx-convo-title') $('cx-convo-title')?.focus({ preventScroll: true })
      else if (hadFocus) slots.convoHead.querySelector('.cx-details-toggle')?.focus({ preventScroll: true })
    }
  }
  const remoteSig = s && typeof s.remoteControl === 'boolean' && s.cliSessionId ? remoteSwitchSignature(s) : ''
  if (remoteSig !== slots.remoteSig) {
    const hadFocus = slots.remote.contains(document.activeElement)
    slots.remoteSig = remoteSig
    slots.remote.replaceChildren(...(remoteSig ? [remoteSwitch(s)] : []))
    if (hadFocus) slots.remote.querySelector('.cx-remote-btn')?.focus({ preventScroll: true })
  }
  const glanceSig = s ? JSON.stringify([s.projectId, state.lookup?.projects.get(s.projectId)?.name, s.cwd, s.branch, s.model, s.effort, st?.since, s.activity, s.summary]) : ''
  if (glanceSig !== slots.glanceSig) {
    slots.glanceSig = glanceSig
    slots.glance.replaceChildren(...(s ? glance(s, st) : []))
  }
  const agentKeys = isConvo ? (s?.agentKeys ?? []).filter(k => agentOf(k)) : []
  const agentsSig = JSON.stringify(agentKeys.map(k => [k, agentOf(k)?.description, agentOf(k)?.name, agentOf(k)?.lifecycle]))
  if (agentsSig !== slots.agentsSig) {
    const focusedKey = slots.agents.contains(document.activeElement) ? document.activeElement.closest('[data-agent]')?.dataset.agent : null
    slots.agentsSig = agentsSig
    slots.agents.replaceChildren(...(agentKeys.length > 0 ? [agentList(agentKeys)] : []))
    const count = agentKeys.length > 0 ? `${agentKeys.length} sub-agent${agentKeys.length === 1 ? '' : 's'}` : ''
    if (slots.detailsCount.textContent !== count) slots.detailsCount.textContent = count
    if (focusedKey) slots.agents.querySelector(`[data-agent="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true })
  }
  if (s?.cwd && !slots.changes.firstChild) slots.changes.replaceChildren(changesSection(s))
  refreshChanges()
  const factsSig = s ? factsSignature(s, st) : ''
  if (factsSig !== slots.factsSig && !slots.facts.contains(document.activeElement)) {
    slots.factsSig = factsSig
    slots.facts.replaceChildren(...(s ? [sessionFacts(s, st)] : []))
    const summary = s ? detailsSummary(s) : ''
    if (slots.summaryCount.textContent !== summary) slots.summaryCount.textContent = summary
  }
  const projectSig = s ? projectSignature(s) : ''
  if (projectSig !== slots.projectSig) {
    if (!slots.project.contains(document.activeElement)) {
      slots.projectSig = projectSig
      slots.project.replaceChildren(...(s ? [projectRow(s)] : []))
    } else if (s) {
      const note = $('cx-project-source')
      if (note && note.textContent !== projectNote(s)) note.textContent = projectNote(s)
    }
  }
  let isAttached = false
  if (s?.cliSessionId) {
    const parts = chatPane(s)
    if (slots.requests.firstChild !== parts.requests) slots.requests.replaceChildren(parts.requests)
    if (slots.chat.firstChild !== parts.chat) {
      slots.chat.replaceChildren(parts.chat)
      isAttached = true
    }
  } else {
    slots.requests.replaceChildren()
    const text = s ? 'No transcript for this session yet.' : 'This session is no longer in the snapshot.'
    if (slots.chat.textContent !== text) slots.chat.replaceChildren(el('p', { class: 'cx-note' }, text))
  }
  const hasRequest = Boolean(slots.requests.querySelector('#approval-input') ?? document.getElementById('question-card'))
  foldWhileRequest(hasRequest)
  syncChatFold(hasRequest)
  if (isAttached) restoreChatScroll()
  applySendFocus(wasInChat)
  approvalDrawn()
  if (s?.cliSessionId) refreshConversation()
}

const CHAT_SHARE = { min: 25, max: 85, step: 5, fallback: 55 }

/** 1.15's grip between the details and the conversation: drag, or ↑ ↓ on it, sets the conversation's share of the panel (kept per window); double-click resets it. */
function chatSplitter(panel) {
  const clamp = share => Math.min(CHAT_SHARE.max, Math.max(CHAT_SHARE.min, Math.round(share)))
  const apply = (share, persist) => {
    const next = clamp(share)
    panel.style.setProperty('--chat-h', `${next}%`)
    split.setAttribute('aria-valuenow', String(next))
    split.setAttribute('aria-valuetext', `Conversation ${next}% of the panel`)
    if (persist) remember('chatShare', next)
    stickChat()
  }
  const split = el('div', { class: 'chat-split', role: 'separator', tabindex: '0', 'aria-orientation': 'horizontal', 'aria-label': 'Conversation height', 'aria-valuemin': String(CHAT_SHARE.min), 'aria-valuemax': String(CHAT_SHARE.max), title: 'Drag or use ↑ ↓ to resize the conversation · double-click to reset' })
  const shareAt = clientY => {
    const box = panel.getBoundingClientRect()
    return ((box.bottom - clientY) / Math.max(1, box.height)) * 100
  }
  split.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    event.preventDefault()
    split.setPointerCapture(event.pointerId)
    split.classList.add('active')
    const move = e => apply(shareAt(e.clientY), false)
    const end = e => {
      split.removeEventListener('pointermove', move)
      split.classList.remove('active')
      apply(shareAt(e.clientY), true)
    }
    split.addEventListener('pointermove', move)
    split.addEventListener('pointerup', end, { once: true })
    split.addEventListener('pointercancel', end, { once: true })
  })
  split.addEventListener('keydown', event => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    event.stopPropagation()
    const now = Number(split.getAttribute('aria-valuenow')) || CHAT_SHARE.fallback
    apply(now + (event.key === 'ArrowUp' ? CHAT_SHARE.step : -CHAT_SHARE.step), true)
  })
  split.addEventListener('dblclick', () => apply(CHAT_SHARE.fallback, true))
  apply(Number(stored('chatShare', CHAT_SHARE.fallback)) || CHAT_SHARE.fallback, false)
  return split
}

const isChatFolded = () => stored('chatFolded', false) === true

/** On the map the Conversation header folds the chat away (kept per window); a pending request unfolds it while it waits. The Conversation view never folds. */
function syncChatFold(hasRequest) {
  const isMap = state.view !== 'conversation'
  const folded = isMap && isChatFolded() && !hasRequest
  const panel = $('cx-panel')
  if (panel.classList.contains('is-chat-folded') !== folded) {
    panel.classList.toggle('is-chat-folded', folded)
    if (!folded) stickChat()
  }
  const head = slots.chat.querySelector('.chat-head')
  if (!head || !isMap) return
  let button = head.querySelector('.cx-chat-fold')
  if (!button) {
    button = el('button', { class: 'icon-btn ghost small cx-chat-fold', type: 'button', onclick: toggleChatFold }, icon('chevron', 'chev'))
    head.append(button)
    head.addEventListener('click', event => {
      if (state.view !== 'conversation' && !event.target.closest('button')) toggleChatFold()
    })
  }
  const label = folded ? 'Show the conversation' : 'Hide the conversation'
  button.setAttribute('aria-expanded', String(!folded))
  button.setAttribute('aria-label', label)
  button.title = label
}

function toggleChatFold() {
  remember('chatFolded', !isChatFolded())
  renderPanel()
  $('cx-panel').querySelector('.cx-chat-fold')?.focus({ preventScroll: true })
}

/** The status line: the status dot, the state and its age ("Needs you 2h"), then one truncated line saying why (a failure, the question asked, or the reason). */
function statusLine(st, note = '') {
  const meta = rowMeta(st.bucket, st.reason)
  const quiet = note || meta.after.replace(/^ · /, '')
  return el(
    'p',
    { class: 'cx-status-line' },
    el('span', { class: `dot b-${st.bucket}`, 'aria-hidden': 'true' }),
    el('span', {}, meta.before, st.since ? ' ' : null, st.since ? el('span', { class: 'age', 'data-since': String(st.since) }, ago(Date.now() - st.since)) : null),
    quiet ? el('span', { class: 'muted', title: quiet }, quiet) : null,
  )
}

/** 1.15's facts grid (project, branch, model, time in state) and what the session is doing now. */
function glance(s, st) {
  const project = state.lookup?.projects.get(s.projectId)
  const fact = (name, value, label, attrs = {}) => el('div', { class: 'cx-fact', title: label }, icon(name), el('span', { class: 'sr-only' }, `${label}: `), el('span', attrs, value))
  const since = st?.since ?? s.stateSince ?? s.lastActivityAt
  const activity = s.activity && s.activity !== st?.reason ? s.activity : null
  const doing = activity ?? (s.summary && s.summary !== st?.reason ? s.summary : null)
  return [
    el(
      'div',
      { class: 'cx-fact-grid' },
      fact('folder', project?.name ?? 'Unknown project', `Project${s.cwd ? ` · ${s.cwd}` : ''}`),
      s.branch ? fact('branch', s.branch, 'Branch') : null,
      s.model ? fact('model', `${shortModel(s.model)}${s.effort ? ` · ${s.effort}` : ''}`, `Model · ${s.model}`) : null,
      since ? fact('clock', ago(Date.now() - since), 'In this state for', { class: 'age', 'data-since': String(since) }) : null,
    ),
    doing ? el('div', { class: 'cx-now' }, icon(activity ? 'activity' : 'objective'), el('span', {}, truncate(doing, 240))) : null,
  ].filter(Boolean)
}

const PARENT_NOTE = { 'side-session': 'Side session of', fork: 'Forked from', 'hand-off': 'Handed off from', spawn: 'Started from' }

function factsSignature(s, st) {
  const parent = s.parent ? state.lookup?.sessions.get(s.parent.key) : null
  return JSON.stringify([
    s.parent?.key,
    parent?.title,
    s.lastReport?.text,
    errorsText(s.publisher?.errors, Date.now()),
  ])
}

function projectSignature(s) {
  return JSON.stringify([
    state.prefs?.projectOverrides?.[s.key] ?? null,
    s.projectId,
    s.projectSource,
    state.lookup?.projects.get(s.projectId)?.name,
    (state.snapshot?.projects ?? []).map(p => `${p.id}=${p.name}`).join('|'),
    state.overrideErrors.get(s.key) ?? null,
  ])
}

/** The folded facts: the last report, lineage, and Orbit's own errors for the session (E-29); the ask and a failure stay above the fold, in the header. */
function sessionFacts(s) {
  const parent = s.parent ? state.lookup?.sessions.get(s.parent.key) : null
  const errors = errorsText(s.publisher?.errors, Date.now())
  return el(
    'dl',
    { class: 'cx-facts' },
    s.lastReport?.text ? [el('dt', {}, 'Last report'), el('dd', { class: 'cx-content' }, truncate(s.lastReport.text, 400))] : null,
    s.parent ? [el('dt', {}, PARENT_NOTE[s.parent.kind] ?? 'Started from'), el('dd', {}, parent ? el('button', { class: 'cx-link', onclick: () => select(parent.key) }, truncate(parent.title, 60)) : 'a session Orbit does not list')] : null,
    errors ? [el('dt', {}, 'Orbit errors'), el('dd', { class: 'cx-muted' }, errors)] : null,
  )
}

/** The Details summary names what is folded inside it, e.g. "Details · last report, 3 Orbit errors". */
function detailsSummary(s) {
  const parts = [s.lastReport?.text ? 'last report' : null, s.parent ? 'started from' : null, s.publisher?.errors?.count > 0 ? `${s.publisher.errors.count} Orbit error${s.publisher.errors.count === 1 ? '' : 's'}` : null, 'project'].filter(Boolean)
  return parts.join(', ')
}

/** While a request is pending, Details folds (without changing the remembered choice) so the chat keeps its room; it opens again when the request ends. */
function foldWhileRequest(hasRequest) {
  if (hasRequest === slots.hasRequest) return
  slots.hasRequest = hasRequest
  if (hasRequest && slots.details.open) {
    slots.isAutoFolded = true
    slots.skipSave = true
    slots.details.open = false
  } else if (!hasRequest && slots.isAutoFolded) {
    slots.isAutoFolded = false
    slots.skipSave = true
    slots.details.open = true
  }
}

/** The project row with its Move control, in its own slot so live facts keep updating while it has focus. */
function projectRow(s) {
  const override = state.prefs?.projectOverrides?.[s.key] ?? null
  const projectName = state.lookup?.projects.get(s.projectId)?.name ?? 'an unknown project'
  const choices = projectChoices(state.snapshot?.projects ?? [], override, override ? null : projectName)
  const menu = el('select', { id: 'cx-project', 'aria-describedby': 'cx-project-source' }, ...choices.map(c => el('option', { value: c.value, selected: c.isCurrent || null }, c.label)))
  const move = el('button', { disabled: true }, 'Move')
  const isNoChange = () => {
    const now = state.prefs?.projectOverrides?.[s.key] ?? null
    const project = state.lookup?.sessions.get(s.key)?.projectId ?? s.projectId
    return menu.value === (now ?? '') || (!now && menu.value === project)
  }
  menu.addEventListener('change', () => (move.disabled = isNoChange()))
  move.addEventListener('click', () => {
    if (isNoChange() || move.disabled) return
    move.disabled = true
    move.textContent = 'Moving…'
    void setProjectOverride(s.key, menu.value || null)
  })
  const error = state.overrideErrors.get(s.key) ?? null
  return el(
    'dl',
    { class: 'cx-facts' },
    el('dt', {}, el('label', { for: 'cx-project' }, 'Project')),
    el('dd', { class: 'cx-project' }, menu, move, el('span', { id: 'cx-project-source', class: 'cx-muted' }, projectNote(s)), error ? el('span', { class: 'err', role: 'alert' }, error) : null),
  )
}

/** Where the session is and how it got there, e.g. "docs, set by you". */
function projectNote(s) {
  const name = state.lookup?.projects.get(s.projectId)?.name ?? 'an unknown project'
  const source = state.prefs?.projectOverrides?.[s.key] ? SOURCE_TEXT.override : (SOURCE_TEXT[s.projectSource] ?? null)
  return source ? `${name}, ${source}` : name
}

async function setProjectOverride(key, projectId) {
  state.overrideErrors.delete(key)
  try {
    const answer = await post('/api/prefs', { projectOverrides: { [key]: projectId } })
    if (answer?.prefs) state.prefs = sanitizePrefs(answer.prefs)
  } catch (error) {
    state.overrideErrors.set(key, isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : 'Couldn’t move it. Try again.')
  }
  document.activeElement?.blur?.()
  renderPanel()
  $('cx-project')?.focus({ preventScroll: true })
}
