import { ago, truncate } from '/shared/format.js'
import { convoHome, queueGroups, statusOf, viewOf } from '/shared/popout.js'
import { $, el, remember, state, visibleSessions } from './page-state.js'
import { noSnapshotText, stateBlock } from './rail.js'
import { invalidateGeometry, renderMap } from './stage.js'
import { hideCard } from './card.js'
import { focusOpenTitle, renderPanel, select } from './panel.js'

const HOME_KEYS = [
  ['n', 'Next session that needs you'],
  ['c', 'New session'],
  ['/', 'Search sessions'],
  ['g', 'Back to the map'],
]

/**
 * Map or Conversation (g, l, the header's toggle), kept per window. The
 * Conversation view keeps the left column, puts the open session's
 * conversation where the map was and leaves the right pane to its details;
 * the map stops drawing while it is shown.
 * @param {unknown} view
 * @param {boolean} [persist]
 */
export function setView(view, persist = true) {
  const next = viewOf(view)
  const changed = next !== state.view
  const convoHadFocus = $('cx-convo').contains(document.activeElement)
  state.view = next
  if (persist) remember('view', next)
  const isConvo = next === 'conversation'
  const body = document.querySelector('.cx-body')
  body.classList.toggle('is-convo', isConvo)
  if (!isConvo) body.classList.remove('is-details-open')
  for (const [id, view] of [['cx-view-map', 'map'], ['cx-view-convo', 'conversation']]) {
    $(id).classList.toggle('is-active', next === view)
    $(id).setAttribute('aria-pressed', String(next === view))
  }
  $('cx-convo').hidden = !isConvo
  $('cx-stage').hidden = isConvo
  for (const node of [$('cx-legend'), document.querySelector('.cx-camera')]) node.hidden = isConvo
  if (isConvo) {
    hideCard()
    $('cx-minimap').hidden = true
  }
  if (!changed) return
  if (state.convo.key) $('cx-panel').hidden = false
  renderPanel()
  if (!isConvo && !state.isMoved) state.camera = null
  invalidateGeometry()
  renderHome()
  renderMap()
  if (isConvo) state.convo.key ? focusOpenTitle() : homeTarget().focus({ preventScroll: true })
  else if (convoHadFocus) $('cx-stage').focus({ preventScroll: true })
}

/** Where focus rests in the Conversation view with nothing open: the first session that needs you, else the heading. */
export function homeTarget() {
  return $('cx-convo').querySelector('.cx-home-row') ?? $('cx-home-title') ?? $('cx-convo')
}

const home = { sig: '' }

/**
 * The Conversation view's centre while no session is open: how many sessions
 * need you, the first few of them (each opens its conversation), and the
 * keys that get there.
 */
export function renderHome() {
  if (state.view !== 'conversation' || state.convo.key) return
  const box = $('cx-convo')
  const isDrawn = box.firstElementChild?.classList.contains('cx-home') === true
  if (!state.snapshot) {
    home.sig = ''
    box.replaceChildren(el('div', { class: 'cx-home' }, stateBlock(noSnapshotText(), Boolean(state.loadError))))
    return
  }
  const now = Date.now()
  const h = convoHome(queueGroups(visibleSessions(), now))
  const projectName = s => state.lookup?.projects.get(s.projectId)?.name ?? ''
  const sig = JSON.stringify([h.heading, h.note, h.more, h.top.map(s => [s.key, s.title, statusOf(s).bucket, statusOf(s).reason, statusOf(s).since, projectName(s)])])
  if (isDrawn && sig === home.sig) return
  home.sig = sig
  const focusedKey = box.contains(document.activeElement) ? (document.activeElement.closest('[data-key]')?.dataset.key ?? null) : null
  const hadFocus = box.contains(document.activeElement)
  box.replaceChildren(
    el(
      'div',
      { class: 'cx-home' },
      el('h2', { id: 'cx-home-title', tabindex: '-1' }, h.heading),
      el('p', { class: 'cx-home-note' }, h.note),
      h.top.length > 0 ? el('ul', { class: 'cx-home-list', 'aria-labelledby': 'cx-home-title' }, ...h.top.map(s => homeRow(s, projectName(s), now))) : null,
      h.more > 0 ? el('p', { class: 'cx-home-more' }, `and ${h.more} more in the list on the left`) : null,
      el('dl', { class: 'cx-home-keys', 'aria-label': 'Keys' }, ...HOME_KEYS.flatMap(([key, text]) => [el('dt', {}, el('kbd', { class: 'key' }, key)), el('dd', {}, text)])),
    ),
  )
  if (!hadFocus) return
  const row = focusedKey ? box.querySelector(`.cx-home-row[data-key="${CSS.escape(focusedKey)}"]`) : null
  ;(row ?? homeTarget()).focus({ preventScroll: true })
}

function homeRow(s, project, now) {
  const st = statusOf(s)
  const meta = [st.reason, project].filter(Boolean).join(' · ')
  return el(
    'li',
    {},
    el(
      'button',
      { class: 'cx-home-row', type: 'button', 'data-key': s.key, title: `Open ${s.title}`, onclick: () => select(s.key) },
      el('span', { class: `dot b-${st.bucket}`, 'aria-hidden': 'true' }),
      el('span', { class: 'cx-home-text' }, el('span', { class: 't' }, truncate(s.title, 100)), meta ? el('span', { class: 'meta' }, meta) : null),
      st.since ? el('span', { class: 'age', 'data-since': String(st.since) }, ago(now - st.since)) : null,
    ),
  )
}
