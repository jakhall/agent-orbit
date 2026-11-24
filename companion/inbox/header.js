import { DEFAULT_FILTERS, TIME_PRESETS } from '/shared/constants.js'
import { ago, limitsView } from '/shared/format.js'
import { headerMeters, queueGroups, shellState, statusOf, viewOf } from '/shared/popout.js'
import { needsYouText } from '/shared/map.js'
import { icon, iconInto } from './icons.js'
import { openSettings } from './sheets.js'
import { $, applyPhase, el, state, stored, visibleSessions } from './page-state.js'
import { retry } from './live.js'
import { renderRail } from './rail.js'
import { patchPrefs } from './actions.js'
import { homeFocus } from './toast.js'
import { invalidateGeometry, renderMap } from './stage.js'
import { openNext } from './keys.js'
import { renderHome, setView } from './convo-view.js'
import { refreshConvo } from './panel.js'

/** The map renders first: it reads the stage's geometry, which is free before the header and queue write and would force a layout after them. */
export function renderAll() {
  let at = performance.now()
  renderMap()
  renderHome()
  applyPhase('map', at)
  at = performance.now()
  renderHeader()
  applyPhase('header', at)
  at = performance.now()
  renderRail()
  applyPhase('rail', at)
  at = performance.now()
  refreshConvo()
  applyPhase('panel', at)
}

export function renderHeader() {
  const sessions = visibleSessions()
  const count = bucket => sessions.filter(s => statusOf(s).bucket === bucket).length
  renderCounts(count('needs-you'), count('working'), sessions.length)
  renderLimits()
  renderControls()
  const shell = shellState({
    now: Date.now(),
    connected: state.connected,
    droppedAt: state.droppedAt,
    isClosed: state.isClosed,
    retriedAt: null,
    hasSnapshot: Boolean(state.snapshot),
    problem: state.loadError,
    acceptedAt: state.acceptedAt,
    generatedAt: state.snapshot?.generatedAt ?? null,
    checkedAt: state.checkedAt,
    isLoading: !state.everAnswered,
    loadFailures: state.loadFailures,
    isPaused: state.prefs?.settings?.paused === true,
    health: state.health?.aggregator ? { isWatching: state.health.aggregator.isWatching !== false, isPaused: state.health.aggregator.isPaused === true, errors: state.health.aggregator.errors ?? [] } : null,
  })
  state.shell = shell
  const notWatching = state.health?.aggregator?.isWatching === false
  const isLive = (shell.kind === 'ok' || shell.kind === 'partial') && !notWatching && Boolean(state.snapshot)
  const word = !state.snapshot && state.loadError ? 'Not loaded' : SHELL_WORD[shell.kind] ?? (isLive ? 'Live' : 'Not live')
  const reason = shell.text || (isLive ? 'Live: the map follows your sessions.' : word)
  const live = $('cx-live')
  if (live.textContent !== word) live.textContent = word
  live.title = reason
  live.className = `cx-live ${isLive ? 'is-live' : 'is-off'}`
  const generatedAt = state.snapshot?.generatedAt ?? null
  const updated = generatedAt ? `Updated ${ago(Date.now() - generatedAt)}` : ''
  if ($('cx-updated').textContent !== updated) $('cx-updated').textContent = updated
  renderShellBanner(shell)
  updateAges()
}

const countParts = { sig: '' }

/** 1.15's counts: the needs-you count in blue as a button (the next session that needs you, as n), then running and listed sessions. */
function renderCounts(needsYou, running, total) {
  const sig = `${needsYou}|${running}|${total}`
  if (countParts.sig === sig) return
  countParts.sig = sig
  const hadFocus = $('cx-counts').contains(document.activeElement)
  $('cx-counts').replaceChildren(
    ...[
      needsYou > 0
        ? el('button', { id: 'cx-need-you', class: 'cx-need-you', title: 'Open the next session that needs you (n)', 'aria-keyshortcuts': 'n', onclick: () => openNext(queueGroups(visibleSessions(), Date.now()).find(g => g.key === 'needs-you')?.rows.map(s => s.key) ?? [], 1) }, el('b', {}, String(needsYou)), needsYouText(needsYou).replace(/^\d+/, ''))
        : null,
      el('span', {}, el('b', {}, String(running)), ' running'),
      el('span', { class: 'cx-total' }, el('b', {}, String(total)), total === 1 ? ' session' : ' sessions'),
    ].filter(Boolean),
  )
  if (hadFocus && !$('cx-counts').contains(document.activeElement)) homeFocus().focus({ preventScroll: true })
}

/** The header's time window and the filters mark (a dot while a filter beyond the time window is on). */
function renderControls() {
  const f = { ...DEFAULT_FILTERS, ...(state.prefs?.filters ?? {}) }
  const time = $('cx-time')
  if (time.options.length === 0) time.replaceChildren(...TIME_PRESETS.map(p => el('option', { value: p.value }, p.label)))
  if (document.activeElement !== time && time.value !== f.time) time.value = f.time
  const isFiltered = Boolean(f.project || f.model || f.lifecycle || f.attentionOnly || !f.showCompleted || !f.showStale)
  const filters = $('cx-filters-open')
  if (filters.classList.contains('on') !== isFiltered) {
    filters.classList.toggle('on', isFiltered)
    filters.title = isFiltered ? 'Filters (some are on)' : 'Filters'
    filters.setAttribute('aria-label', filters.title)
  }
}

export const narrowHeader = window.matchMedia('(max-width: 900px)')

export function placeholderFits() {
  $('cx-search').placeholder = 'Search'
}

export function usageView() {
  return limitsView(state.visible?.usage ?? state.snapshot?.usage ?? null, Date.now())
}

/** The rate-limit meters at the right of the footer, one button: each a single row of dot, text and neutral bar, the level by a dot (amber from 80%, coral from 95%), muted when the reading is old; it opens Settings at every window with its reset. */
export function renderLimits() {
  const meters = headerMeters(usageView(), false)
  const box = $('cx-limits')
  const sig = meters.map(m => `${m.name}|${m.level}`).join(',')
  if (box.dataset.sig === sig) return
  box.dataset.sig = sig
  box.hidden = meters.length === 0
  box.setAttribute('aria-label', `${meters.map(m => m.name).join(' ')} Show all usage limits.`)
  box.title = meters.map(m => m.title).join(' · ')
  box.replaceChildren(
    ...meters.map(m =>
      el(
        'span',
        { class: `cx-meter is-${m.level}${m.isStale ? ' is-stale' : ''}`, 'aria-hidden': 'true' },
        el('span', { class: 'dot' }),
        el('span', { class: 't' }, m.text, m.more ? el('span', { class: 'more' }, ` +${m.more}`) : null),
        el('span', { class: 'bar' }, el('span', { style: `width:${Math.min(100, Math.max(0, m.percent))}%` })),
      ),
    ),
  )
}

const SHELL_WORD = { ok: 'Live', partial: 'Live', paused: 'Paused', loading: 'Loading…', reconnecting: 'Reconnecting…', 'load-failed': 'Not loaded', 'no-data': 'Live' }

/** The shell banner under the header: the reason the page is not live, its age, and one action (DESIGN.md "Shell banner"). */
function renderShellBanner(shell) {
  const box = $('cx-shell')
  const shown = !['ok', 'partial', 'loading', 'no-data'].includes(shell.kind) && Boolean(shell.text)
  const sig = shown ? `${shell.kind}|${shell.text}|${shell.action}` : ''
  if (box.dataset.sig === sig) return
  const hadFocus = box.contains(document.activeElement)
  box.dataset.sig = sig
  box.hidden = !shown
  box.setAttribute('role', shell.isAlert ? 'alert' : 'status')
  if (!shown) {
    box.replaceChildren()
    if (hadFocus) homeFocus().focus({ preventScroll: true })
    return
  }
  const action = shell.action === 'resume' ? el('button', { onclick: () => void patchPrefs({ settings: { paused: false } }) }, 'Resume') : shell.action === 'retry' ? el('button', { onclick: retry }, 'Retry') : null
  const dot = shell.kind === 'paused' || shell.kind === 'not-live' ? 'b-idle' : shell.kind === 'reconnecting' || shell.kind === 'stale' ? 'b-needs-you' : 'b-failed'
  box.replaceChildren(...[el('span', { class: `dot ${dot}`, 'aria-hidden': 'true' }), el('span', {}, shell.text), action].filter(Boolean))
}

function updateAges() {
  const now = Date.now()
  for (const span of document.querySelectorAll('#cx-rail .age[data-since], #cx-panel .age[data-since], #cx-convo .age[data-since]')) {
    const text = ago(now - Number(span.dataset.since))
    if (span.textContent !== text) span.textContent = text
  }
}

const KIND_LEGEND = [
  ['robot', 'Session'],
  ['fork', 'Forked session'],
  ['subagent', 'Sub-agent'],
  ['folder', 'Project name'],
  ['branch', 'Worktree branch'],
]

const LEGEND = [
  ['needs-you', 'Needs you'],
  ['working', 'Running'],
  ['review', 'Ready for review'],
  ['failed', 'Failed'],
  ['idle', 'Idle or stale'],
]

/** 1.15's chrome: icon buttons with their tooltips, the time window, the view toggle and the Legend. */
export function bindChrome() {
  for (const [id, name] of [['cx-filters-open', 'filter'], ['cx-view-map', 'graph'], ['cx-view-convo', 'turns'], ['cx-new-open', 'plus'], ['cx-settings-open', 'sliders'], ['cx-zoom-in', 'plus'], ['cx-zoom-out', 'minus'], ['cx-fit', 'fit'], ['cx-reposition', 'arrange']]) iconInto($(id), name)
  $('cx-time').addEventListener('change', () => void patchPrefs({ filters: { time: $('cx-time').value } }))
  $('cx-filters-open').addEventListener('click', () => openSettings('cx-s-time'))
  $('cx-view-map').addEventListener('click', () => setView('map'))
  $('cx-view-convo').addEventListener('click', () => setView('conversation'))
  setView(viewOf(stored('view', 'map')), false)
  $('cx-legend-items').replaceChildren(
    ...LEGEND.map(([bucket, label]) => el('span', { class: 'cx-legend-item' }, el('span', { class: `dot b-${bucket}`, 'aria-hidden': 'true' }), label)),
    el('span', { class: 'cx-legend-item' }, icon('hub'), 'Project'),
    ...KIND_LEGEND.map(([name, label]) => el('span', { class: 'cx-legend-item' }, icon(name, 'kind'), label)),
    el('span', { class: 'cx-legend-item' }, icon('diamond'), 'Pull request'),
    el('span', { class: 'cx-legend-item' }, el('span', { class: 'cx-pin', 'aria-hidden': 'true' }), 'Pinned'),
  )
  $('cx-legend').addEventListener('toggle', () => {
    invalidateGeometry()
    renderMap()
  })
}
