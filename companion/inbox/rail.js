import { DEFAULT_FILTERS, TIME_PRESETS } from '/shared/constants.js'
import { ago, truncate } from '/shared/format.js'
import { isGroupOpen, queueGroups, rowMeta, rowSecondLine, statusOf } from '/shared/popout.js'
import { GROUP_ICON, icon } from './icons.js'
import { $, el, remember, state, stored, visibleSessions } from './page-state.js'
import { retry } from './live.js'
import { patchPrefs, showHidden } from './actions.js'
import { select } from './panel.js'
import { robotIcon, tintOf, titleOf } from './identity.js'

export function emptyText() {
  const time = state.prefs?.filters?.time ?? DEFAULT_FILTERS.time
  if (time === 'active') return 'No active sessions right now.'
  if (time === 'all') return 'No sessions yet.'
  const preset = TIME_PRESETS.find(p => p.value === time)
  return preset ? `No sessions in the ${preset.label.toLowerCase()}.` : 'No sessions in this time window.'
}

export function noSnapshotText() {
  return state.loadError ?? (state.everAnswered ? 'No sessions yet: start a Claude desktop session with Orbit.' : 'Loading sessions…')
}

export function stateBlock(text, withRetry) {
  return el('div', { class: 'cx-empty' }, el('p', {}, text), withRetry ? el('button', { onclick: retry }, 'Retry') : null)
}

const railRows = new Map()
const railSections = new Map()

export const railParts = { strip: null, box: null }

/** The rail's two parts: a narrow strip of group counts (shown below 860 px) and the groups themselves. */
function railBox() {
  const rail = $('cx-rail')
  if (!railParts.box) {
    railParts.strip = el('div', { class: 'cx-strip' })
    railParts.box = el('div', { id: 'cx-groups', class: 'cx-groups' })
    rail.replaceChildren(railParts.strip, railParts.box)
  }
  return railParts.box
}

export function setRailOpen(isOpen) {
  const body = document.querySelector('.cx-body')
  body.classList.toggle('is-rail-open', isOpen)
  railParts.strip?.querySelector('.cx-strip-toggle')?.setAttribute('aria-expanded', String(isOpen))
}

function renderStrip(groups, filtered = '') {
  const strip = railParts.strip
  const focused = strip.contains(document.activeElement) ? document.activeElement.dataset.strip : null
  const isOpen = document.querySelector('.cx-body').classList.contains('is-rail-open')
  strip.replaceChildren(
    el('button', { class: 'cx-strip-toggle', 'data-strip': 'toggle', 'aria-expanded': String(isOpen), 'aria-controls': 'cx-groups', title: 'Show or hide the queue', onclick: () => setRailOpen(!document.querySelector('.cx-body').classList.contains('is-rail-open')) }, el('span', { class: 'sr-only' }, 'Queue'), el('span', { 'aria-hidden': 'true' }, '☰')),
    ...groups.map(g =>
      el(
        'button',
        { class: `cx-strip-item b-${g.key}`, 'data-strip': g.key, 'aria-label': `${g.label}: ${g.rows.length}. Show them`, title: g.label, onclick: () => openRailAt(g.key) },
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('span', { class: 'n' }, String(g.rows.length)),
        el('span', { class: 'w', 'aria-hidden': 'true' }, STRIP_WORD[g.key] ?? g.label),
      ),
    ),
    ...(filtered ? [el('button', { class: 'cx-strip-item cx-strip-filter', 'data-strip': 'filter', 'aria-label': `Filtered: ${filtered}. Show the queue to clear it`, title: `Filtered: ${filtered}`, onclick: () => openRailAt(groups[0]?.key ?? '') }, el('span', { class: 'n', 'aria-hidden': 'true' }, '⊘'), el('span', { class: 'w', 'aria-hidden': 'true' }, 'filter'))] : []),
  )
  if (focused) strip.querySelector(`[data-strip="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
}

const STRIP_WORD = { 'needs-you': 'need', failed: 'failed', review: 'review', working: 'work', idle: 'idle' }

const railGroups = { saved: stored('railGroups', {}) }

/** Whether a left-column group is open (Working and Idle start collapsed; every group opens while searching). */
export function groupOpen(key) {
  return isGroupOpen(key, railGroups.saved, Boolean(state.query))
}

export function toggleGroup(key) {
  railGroups.saved = { ...railGroups.saved, [key]: !groupOpen(key) }
  remember('railGroups', railGroups.saved)
  renderRail()
}

function openRailAt(groupKey) {
  railParts.opener = document.activeElement
  if (!groupOpen(groupKey)) toggleGroup(groupKey)
  setRailOpen(true)
  const section = railParts.box?.querySelector(`[data-group="${CSS.escape(groupKey)}"]`)
  section?.scrollIntoView({ block: 'start' })
  section?.querySelector('.cx-row')?.focus({ preventScroll: true })
}

export function renderRail() {
  const rail = railBox()
  const focusedKey = rail.contains(document.activeElement) ? document.activeElement.dataset?.key : null
  const listed = state.query ? visibleSessions().filter(s => state.matches.has(s.key)) : visibleSessions()
  const groups = queueGroups(listed, Date.now())
  const filterNote = state.snapshot ? filterHead() : null
  renderStrip(state.snapshot ? groups : [], filterNote ? filterParts.sig : '')
  if (!state.snapshot) {
    rail.replaceChildren(stateBlock(noSnapshotText(), Boolean(state.loadError)))
    return
  }
  const hiddenNote = hiddenFooter()
  if (groups.length === 0) {
    rail.replaceChildren(...[filterNote, stateBlock(state.query ? `No sessions match “${state.query.trim()}”. Esc clears the search.` : emptyText(), false), hiddenNote].filter(Boolean))
    return
  }
  const seen = new Set()
  const sections = groups.map(g => {
    const isOpen = groupOpen(g.key)
    const rows = g.rows.map((s, i) => {
      seen.add(s.key)
      const st = statusOf(s)
      const isCurrent = state.selected === `s:${s.key}`
      const line = rowSecondLine(s, st.reason)
      const isAsk = Boolean(line && s.lastReport?.ask && line === rowSecondLine({ lastReport: { ask: s.lastReport.ask } }, st.reason))
      const hotkey = g.key === 'needs-you' && isOpen && i < 9 ? String(i + 1) : null
      const meta = rowMeta(st.bucket, st.reason)
      const tint = tintOf(s)
      const sig = `${st.bucket}|${titleOf(s)}|${tint}|${st.reason}|${st.since}|${isCurrent}|${line}|${isAsk}|${s.isPinned === true}|${hotkey}`
      const cached = railRows.get(s.key)
      if (cached && cached.sig === sig) return cached.el
      const row = el(
        'button',
        { class: `cx-row b-${st.bucket}${hotkey ? ' keyed' : ''}`, 'data-key': s.key, 'aria-current': isCurrent ? 'true' : null, 'aria-keyshortcuts': hotkey, title: line ? `${st.reason} · ${line}` : st.reason, onclick: () => select(s.key) },
        hotkey ? el('kbd', { class: 'key', 'aria-hidden': 'true' }, hotkey) : null,
        el('span', { class: 't' }, s.isPinned ? [el('span', { class: 'cx-pin', 'aria-hidden': 'true' }), el('span', { class: 'sr-only' }, 'Pinned: ')] : null, tint !== 'blue' ? robotIcon(s) : null, truncate(titleOf(s), 80)),
        el(
          'span',
          { class: 'meta' },
          el('span', { class: `dot b-${st.bucket}`, 'aria-hidden': 'true' }),
          el('span', { class: 'why' }, meta.before),
          st.since ? ' ' : null,
          el('span', { class: 'age', 'data-since': st.since ?? null }, st.since ? ago(Date.now() - st.since) : ''),
          meta.after,
          line ? el('span', { class: isAsk ? 'sub is-ask' : 'sub' }, ` · ${line}`) : null,
        ),
      )
      railRows.set(s.key, { sig, el: row })
      return row
    })
    let section = railSections.get(g.key)
    if (!section) {
      const head = el(
        'button',
        { class: 'cx-group-head', 'aria-controls': `cx-group-${g.key}`, onclick: () => toggleGroup(g.key) },
        icon('chevron', 'chev'),
        icon(GROUP_ICON[g.key] ?? 'session', 'accent'),
        el('span', { class: 'h-title' }, g.label),
        el('span', { class: 'h-count' }),
      )
      const body = el('div', { class: 'cx-group-rows', id: `cx-group-${g.key}` })
      section = el('section', { class: 'cx-group', 'data-group': g.key }, head, body)
      railSections.set(g.key, section)
    }
    const [head, body] = section.children
    section.setAttribute('aria-label', `${g.label}, ${g.rows.length}`)
    head.setAttribute('aria-expanded', String(isOpen))
    head.title = isOpen ? `Collapse ${g.label}` : `Expand ${g.label}`
    const count = head.querySelector('.h-count')
    if (count.textContent !== String(g.rows.length)) count.textContent = String(g.rows.length)
    body.hidden = !isOpen
    const wanted = isOpen ? rows : []
    if (wanted.length !== body.children.length || wanted.some((node, i) => body.children[i] !== node)) body.replaceChildren(...wanted)
    return section
  })
  for (const key of railRows.keys()) if (!seen.has(key)) railRows.delete(key)
  const wanted = [filterNote, ...sections, hiddenNote].filter(Boolean)
  if (wanted.length !== rail.children.length || wanted.some((node, i) => rail.children[i] !== node)) rail.replaceChildren(...wanted)
  if (focusedKey && !rail.contains(document.activeElement)) rail.querySelector(`.cx-row[data-key="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true })
}

const filterParts = { el: null, sig: '' }

/**
 * A note at the top of the queue whenever a filter beyond the time window is
 * on (set in the pane or by an older page), naming it, with Clear; a filter
 * must never hide sessions silently.
 */
function filterHead() {
  const f = { ...DEFAULT_FILTERS, ...(state.prefs?.filters ?? {}) }
  const parts = [
    f.project ? `${state.lookup?.projects.get(f.project)?.name ?? 'one project'} only, plus sessions that need you and pinned ones` : null,
    f.model ? `${f.model} only` : null,
    f.lifecycle ? `${f.lifecycle} only` : null,
    f.attentionOnly ? 'needs you only' : null,
    !f.showCompleted ? 'finished hidden' : null,
    !f.showStale ? 'stale hidden' : null,
  ].filter(Boolean)
  if (parts.length === 0) return null
  const sig = parts.join(', ')
  if (filterParts.sig !== sig || !filterParts.el) {
    filterParts.sig = sig
    filterParts.el = el('div', { class: 'cx-filter-note', role: 'note' }, el('span', {}, `Filtered: ${sig}`), el('button', { class: 'cx-link', onclick: () => void patchPrefs({ filters: { ...DEFAULT_FILTERS, time: f.time } }) }, 'Clear'))
  }
  return filterParts.el
}

const hiddenParts = { el: null, count: -1 }

/** "N hidden until active · Show hidden" under the queue, as in the pane; null when nothing is hidden. */
function hiddenFooter() {
  const count = state.visible?.hiddenCount ?? 0
  if (count === 0) return null
  if (hiddenParts.count !== count || !hiddenParts.el) {
    const hadFocus = hiddenParts.el?.contains(document.activeElement)
    hiddenParts.count = count
    hiddenParts.el = el('div', { class: 'cx-hidden-note' }, el('span', {}, `${count} hidden until active`), el('button', { class: 'cx-link', onclick: () => void showHidden() }, 'Show hidden'))
    if (hadFocus) queueMicrotask(() => hiddenParts.el?.querySelector('button')?.focus({ preventScroll: true }))
  }
  return hiddenParts.el
}
