import { isCharacterKey, keyAction, keyInScope, nextFocusKey, openRowKeys, queueGroups } from '/shared/popout.js'
import { bucketOf, nearestInDirection, searchMatches, sessionName } from '/shared/map.js'
import { focusPan, safeArea } from '/shared/camera.js'
import { focusReply } from './composer.js'
import { isDialogOpen, openNewSession } from './sheets.js'
import { $, PAN_STEP, state, visibleSessions, ZOOM_STEP } from './page-state.js'
import { groupOpen, renderRail } from './rail.js'
import { openInClaude, triage } from './actions.js'
import { runUndo, toast, toastState } from './toast.js'
import { cameraGoal, fitAndRender, panBy, panelLeft, renderMap, reservedBottom, SAFE_MARGIN_PX, settleAnimation, stageSize, zoomAt } from './stage.js'
import { showCard } from './card.js'
import { homeTarget, setView } from './convo-view.js'
import { select } from './panel.js'

/** The session a key acts on: the focused one on the map, else the open one. */
export function targetKey() {
  const active = document.activeElement
  const row = active instanceof HTMLElement ? active.closest('.cx-row, .cx-home-row') : null
  if (row?.dataset.key) return row.dataset.key
  if (active instanceof HTMLElement && active.closest('#cx-rail, .cx-camera, #cx-minimap, #cx-toast')) return null
  if (active instanceof HTMLElement && active.closest('#cx-card') && state.cardKey) return state.cardKey
  if (active instanceof HTMLElement && active.closest('#cx-panel, #cx-convo') && state.convo.key) return state.convo.key
  return state.focusNode ?? (state.selected?.startsWith('s:') ? state.selected.slice(2) : null)
}

/** Moves map focus to a session: dashed ring, the card, an announcement, and a pan if it is out of sight. */
function focusSession(key) {
  state.focusNode = key
  renderMap()
  const node = state.visible?.nodes.find(n => n.id === `s:${key}`)
  if (node && state.camera) {
    const safe = safeArea(stageSize(), { panelLeft: panelLeft(), reservedBottom: reservedBottom(), margin: SAFE_MARGIN_PX })
    const goal = cameraGoal()
    const next = focusPan(goal, stageSize(), node, safe)
    if (next !== goal) {
      settleAnimation()
      state.camera = next
      renderMap()
    }
  }
  const s = state.lookup?.sessions.get(key)
  if (s) $('cx-live-region').textContent = sessionName(s, bucketOf(s), state.lookup, Date.now()).split('\n').slice(0, 2).join(', ')
  showCard(key)
}

/**
 * Where focus was, so that when the control it was on disappears (a row
 * marked done or hidden, a card closing, the hidden note going) it moves to
 * the next row, the panel or the map, never to the page body, where keys do
 * nothing.
 */
const focusTrail = { region: null, key: null, order: [] }

export function noteFocus(event) {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const row = target.closest('.cx-row, .cx-home-row')
  focusTrail.region = row ? (row.classList.contains('cx-home-row') ? 'home' : 'row') : target.closest('#cx-rail') ? 'rail' : target.closest('#cx-card') ? 'card' : target.closest('#cx-panel, #cx-convo') ? 'panel' : target.closest('#cx-stage') ? 'stage' : null
  focusTrail.key = row?.dataset.key ?? (focusTrail.region === 'card' ? state.cardKey : null)
  focusTrail.order = railOrder()
}

export function recoverFocus() {
  const active = document.activeElement
  if (active && active !== document.body && active.isConnected) return
  if (isDialogOpen()) return
  const rail = $('cx-rail')
  const row = key => (key ? rail.querySelector(`.cx-row[data-key="${CSS.escape(key)}"]`) : null)
  let target = null
  if (focusTrail.region === 'row') target = row(nextFocusKey(focusTrail.order, focusTrail.key))
  else if (focusTrail.region === 'rail') target = rail.querySelector('.cx-row')
  else if (focusTrail.region === 'home') target = homeTarget()
  else if (focusTrail.region === 'panel' && state.convo.key) target = [$('cx-panel-title'), $('cx-convo-title')].find(n => n && n.getClientRects().length > 0) ?? null
  ;(target ?? (state.view === 'conversation' ? homeTarget() : $('cx-stage'))).focus({ preventScroll: true })
}

export function railOrder() {
  return openRowKeys(queueGroups(visibleSessions(), Date.now()), groupOpen)
}

function cycle(list, current, step) {
  if (list.length === 0) return null
  const i = current ? list.indexOf(current) : -1
  return list[(i + step + list.length) % list.length] ?? null
}

export function runSearch(query) {
  state.query = query
  state.matches = new Set(searchMatches(visibleSessions(), query, state.lookup?.projects ?? new Map()))
  $('cx-search-count').textContent = query.trim() ? `${state.matches.size} ${state.matches.size === 1 ? 'match' : 'matches'}` : ''
  renderRail()
  renderMap()
}

/** The page's key map (KEY_MAP in shared/popout.js); keys typed in a field stay with the field. */
export function onKey(event) {
  const target = event.target
  if (isDialogOpen()) return
  if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]')) return
  const action = keyAction(event)
  if (!action || action === 'back') return
  const inScope = target instanceof HTMLElement && Boolean(target.closest('#cx-stage, #cx-rail, #cx-convo, #cx-card, #cx-panel, #cx-toast, .cx-camera, #cx-minimap'))
  if (!keyInScope({ isCharacter: isCharacterKey(event.key), inScope, action, toastShown: !$('cx-toast').hidden && Boolean(toastState.undo) })) return
  const onStage = target === $('cx-stage')
  const key = targetKey()
  const run = {
    'next-needs-you': () => openNext(queueGroups(visibleSessions(), Date.now()).find(g => g.key === 'needs-you')?.rows.map(s => s.key) ?? [], 1),
    'previous-needs-you': () => openNext(queueGroups(visibleSessions(), Date.now()).find(g => g.key === 'needs-you')?.rows.map(s => s.key) ?? [], -1),
    next: () => openNext(railOrder(), 1),
    previous: () => openNext(railOrder(), -1),
    'open-panel': () => onStage && state.focusNode && select(state.focusNode, $('cx-stage')),
    'open-in-claude': () => key && void openInClaude(key),
    reply: () => key && ((state.convo.key === key && !state.convo.agent) || select(key), focusReply(), true),
    done: () => key && void triage('done', key),
    'snooze-hour': () => key && void triage('snooze-hour', key),
    'snooze-tomorrow': () => key && void triage('snooze-tomorrow', key),
    hide: () => key && void triage('hide', key),
    search: () => $('cx-search').focus(),
    'move-left': () => onStage && moveFocus('left'),
    'move-right': () => onStage && moveFocus('right'),
    'move-up': () => onStage && moveFocus('up'),
    'move-down': () => onStage && moveFocus('down'),
    'pan-left': () => onStage && panBy(-PAN_STEP, 0),
    'pan-right': () => onStage && panBy(PAN_STEP, 0),
    'pan-up': () => onStage && panBy(0, -PAN_STEP),
    'pan-down': () => onStage && panBy(0, PAN_STEP),
    'zoom-in': () => onStage && zoomAt(1 / ZOOM_STEP),
    'zoom-out': () => onStage && zoomAt(ZOOM_STEP),
    fit: () => onStage && fitAndRender(),
    'new-session': () => (openNewSession(), true),
    'view-conversation': () => (setView('conversation'), true),
    'view-map': () => (setView('map'), true),
    undo: () => (toastState.undo ? void runUndo() : toast('Nothing to undo.')),
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [`open-${n}`, () => openNth(n)])),
  }[action]
  if (!run) return
  const result = run()
  if (result !== false && result !== null && result !== undefined && result !== '') event.preventDefault()
  else if (['next-needs-you', 'previous-needs-you', 'next', 'previous', 'search'].includes(action)) event.preventDefault()
}

/** Digits open the queue's Nth item, as the pane does. */
function openNth(n) {
  const key = railOrder()[n - 1]
  if (!key) return toast(`The queue has fewer than ${n} sessions.`)
  select(key, state.view === 'conversation' ? null : $('cx-stage'))
  return true
}

export function openNext(list, step) {
  const current = state.selected?.startsWith('s:') ? state.selected.slice(2) : state.focusNode
  const next = cycle(list, list.includes(current) ? current : null, step)
  if (!next) return toast(step > 0 && list.length === 0 ? 'Nothing needs you.' : 'Nothing there.')
  state.focusNode = next
  select(next, state.view === 'conversation' ? null : $('cx-stage'))
  return true
}

function moveFocus(direction) {
  const nodes = (state.visible?.nodes ?? []).filter(n => n.kind === 'session')
  if (nodes.length === 0) return false
  const from = state.focusNode ?? (state.selected?.startsWith('s:') ? state.selected.slice(2) : null)
  if (!from) {
    const first = railOrder()[0]
    if (first) focusSession(first)
    return true
  }
  const next = nearestInDirection(nodes, `s:${from}`, direction)
  if (next) focusSession(next.slice(2))
  return true
}
