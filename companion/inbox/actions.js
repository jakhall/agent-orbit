import { truncate } from '/shared/format.js'
import { handOffLink } from '/shared/links.js'
import { donePatch, isNoWindow, menuStep, NO_WINDOW_TEXT, snoozePatch, snoozeUntil } from '/shared/popout.js'
import { sanitizePrefs } from '/shared/prefs.js'
import { bucketOf } from '/shared/map.js'
import { icon } from './icons.js'
import { commandsFor, focusReply, openSkillShelf } from './composer.js'
import { openNewSession, openSettings } from './sheets.js'
import { $, el, post, state } from './page-state.js'
import { toast } from './toast.js'
import { fitAndRender } from './stage.js'
import { load } from './live.js'
import { targetKey } from './keys.js'
import { select } from './panel.js'

/** Saves a prefs patch for every window (the prefs stamp then reloads the page's view); true when it was saved. */
export async function patchPrefs(patch) {
  try {
    const answer = await post('/api/prefs', patch)
    if (answer?.prefs) state.prefs = sanitizePrefs(answer.prefs)
    return true
  } catch (error) {
    toast(isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : 'Couldn’t save that. Try again.')
    return false
  }
}

async function layOutAndFit() {
  state.layoutKey = null
  await load()
  fitAndRender()
}

/** Clears every dragged place (keeping collapsed projects), lays the map out afresh and fits it; the toast's undo puts the dragged places back. */
export async function repositionMap() {
  const dragged = { ...(state.prefs?.positions ?? {}) }
  if (!(await patchPrefs({ resetPositions: true }))) return
  await layOutAndFit()
  if (!Object.keys(dragged).length) return toast('Map repositioned.')
  toast('Map repositioned.', async () => {
    if (await patchPrefs({ positions: dragged })) await layOutAndFit()
  })
}

/** The palette's actions, taken once when it opens: the page's own, then the focused session's, each carrying that session's key so it runs on the session its label names. */
export function paletteActions() {
  const actions = [
    { id: 'new-session', label: 'New session', hotkey: 'c' },
    { id: 'settings', label: 'Settings' },
    { id: 'fit', label: 'Fit the map', hotkey: '0' },
    { id: 'reposition', label: 'Reposition the map' },
    { id: 'search', label: 'Search sessions', hotkey: '/' },
  ]
  if ((state.visible?.hiddenCount ?? 0) > 0) actions.push({ id: 'show-hidden', label: `Show hidden sessions (${state.visible.hiddenCount})` })
  const key = targetKey()
  const s = key ? state.lookup?.sessions.get(key) : null
  if (!s) return actions
  const name = truncate(s.title, 40)
  const forIt = (id, verb, hotkey) => ({ id, label: `${verb}: ${name}`, verb, key: s.key, hotkey })
  if (s.canOpen) actions.push(forIt('open-in-claude', 'Open in Claude', 'o'))
  actions.push(forIt('reply', 'Reply', 'r'), forIt('done', 'Done', 'd'), forIt('snooze-hour', 'Snooze 1 hour', 's'), forIt('snooze-tomorrow', 'Snooze until tomorrow', 'Shift+S'))
  if (bucketOf(s) !== 'needs-you') actions.push(forIt('hide', 'Hide', 'h'))
  actions.push(forIt('pin', isPinned(s.key) ? 'Unpin' : 'Pin', null))
  if (s.canMessage) actions.push(...skillActions(s.key, name))
  return actions
}

function skillActions(key, name) {
  const listed = commandsFor(key)
  const has = listed?.known ? new Set(listed.commands.map(c => c.name.toLowerCase())) : null
  const seen = new Set()
  const out = []
  for (const group of state.prefs?.skillShelf?.groups ?? []) {
    for (const item of group.items) {
      if (seen.has(item.command) || (has && !has.has(item.command.toLowerCase()))) continue
      seen.add(item.command)
      out.push({ id: `skill:${item.command}`, label: `Apply ${item.label}: ${name}`, verb: `Apply ${item.label}`, key, skill: { icon: item.icon, color: item.color }, search: `apply ${item.label} /${item.command} ${group.name}`.toLowerCase() })
    }
  }
  return out
}

export function runAction(id, key = null) {
  if (id.startsWith('skill:')) {
    if (!key) return
    if (state.convo.key !== key || state.convo.agent) select(key)
    return openSkillShelf(id.slice('skill:'.length))
  }
  const run = {
    'new-session': () => openNewSession(),
    settings: () => openSettings(),
    fit: () => fitAndRender(),
    reposition: () => void repositionMap(),
    search: () => $('cx-search').focus(),
    'show-hidden': () => void showHidden(),
    'open-in-claude': () => key && void openInClaude(key),
    reply: () => key && ((state.convo.key === key && !state.convo.agent) || select(key), focusReply()),
    done: () => key && void triage('done', key),
    'snooze-hour': () => key && void triage('snooze-hour', key),
    'snooze-tomorrow': () => key && void triage('snooze-tomorrow', key),
    hide: () => key && void triage('hide', key),
    pin: () => key && void togglePin(key),
  }[id]
  run?.()
}

export async function showHidden() {
  try {
    const answer = await post('/api/prefs', { hidden: {} })
    if (answer?.prefs) state.prefs = sanitizePrefs(answer.prefs)
    toast('Hidden sessions are shown again.')
  } catch (error) {
    toast(isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : 'Couldn’t show them. Try again.')
  }
}

/** A standard action as an icon button: its name is the tooltip and the accessible name. */
export function iconButton(name, label, onclick, attrs = {}) {
  const { class: extra, ...rest } = attrs
  return el('button', { class: `icon-btn${extra ? ` ${extra}` : ''}`, title: label, 'aria-label': label, onclick, ...rest }, icon(name))
}

/**
 * A session's actions in the panel, as 1.15 drew them: one primary Open, then
 * icon buttons for Pin, Done, Snooze (a menu: an hour, until tomorrow) and
 * Hide (not for a session that needs you).
 */
export function actionButtons(key) {
  const s = state.lookup?.sessions.get(key)
  const open = s?.canOpen ? el('button', { class: 'primary with-icon', 'data-action': 'open', title: 'Open in Claude (o)', 'aria-keyshortcuts': 'o', onclick: () => void openInClaude(key) }, icon('open'), 'Open') : null
  return el('div', { class: 'cx-actions', role: 'group', 'aria-label': 'Actions' }, open, ...sessionActions(key, s && bucketOf(s) === 'needs-you' ? ['pin', 'done', 'snooze'] : ['pin', 'done', 'snooze', 'hide']))
}

/** The card's actions: small ghost icon buttons in its title row, no Open (it stays in the panel and on `o`). */
export function cardActions(key, actions) {
  return el('div', { class: 'cx-card-actions', role: 'group', 'aria-label': 'Actions' }, ...sessionActions(key, actions, 'small'))
}

/** Pin, Done, Snooze and Hide as icon buttons, with one name, tooltip and key hint wherever they appear. */
function sessionActions(key, actions, size = '') {
  const extra = size ? { class: size } : {}
  const make = {
    pin: () => iconButton('pin', pinTitle(key), () => void togglePin(key), { ...extra, 'data-action': 'pin', 'data-key': key, 'aria-pressed': String(isPinned(key)) }),
    done: () => iconButton('done', 'Done (d)', () => void triage('done', key), { ...extra, 'data-action': 'done', 'aria-keyshortcuts': 'd' }),
    snooze: () => snoozeMenu(key, size),
    hide: () => iconButton('moon', 'Hide until it is active again (h)', () => void triage('hide', key), { ...extra, 'data-action': 'hide', 'aria-keyshortcuts': 'h' }),
  }
  return actions.map(action => make[action]())
}

const SNOOZE_ITEMS = [
  ['snooze-hour', 'For an hour', 's'],
  ['snooze-tomorrow', 'Until 9:00 tomorrow', 'Shift+S'],
]

/** The Snooze icon button and its menu: arrows move, Enter chooses, Esc closes back to the button, Tab or a press outside closes it. */
function snoozeMenu(key, size = '') {
  const items = SNOOZE_ITEMS.map(([action, label, keys]) => el('button', { role: 'menuitem', tabindex: '-1', 'data-action': action, 'aria-keyshortcuts': keys, onclick: () => (close(false), void triage(action, key)) }, el('span', {}, label), el('kbd', { class: 'key', 'aria-hidden': 'true' }, keys)))
  const menu = el('div', { class: 'cx-menu', role: 'menu', 'aria-label': 'Snooze', hidden: true }, ...items)
  const button = iconButton('snooze', 'Snooze (s: an hour, Shift+S: until tomorrow)', () => (menu.hidden ? openAt(0) : close(false)), { ...(size ? { class: size } : {}), 'data-action': 'snooze', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-keyshortcuts': 's' })
  const wrap = el('span', { class: 'cx-menu-wrap' }, button, menu)
  const onOutside = event => {
    if (!wrap.contains(event.target)) close(false)
  }
  function openAt(index) {
    menu.hidden = false
    button.setAttribute('aria-expanded', 'true')
    items[index].focus()
    document.addEventListener('pointerdown', onOutside, true)
  }
  function close(refocus) {
    if (menu.hidden) return
    menu.hidden = true
    button.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', onOutside, true)
    if (refocus) button.focus()
  }
  button.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    openAt(event.key === 'ArrowUp' ? items.length - 1 : 0)
  })
  menu.addEventListener('keydown', event => {
    const step = menuStep(event.key, items.indexOf(document.activeElement), items.length)
    if (!step) return
    if ('index' in step) {
      event.preventDefault()
      items[step.index].focus()
      return
    }
    if (step.refocus) {
      event.preventDefault()
      event.stopPropagation()
    }
    close(step.refocus)
  })
  return wrap
}

function isPinned(key) {
  return (state.prefs?.pinned ?? []).includes(key)
}

function pinTitle(key) {
  return isPinned(key) ? 'Pinned: stays listed whatever the time window or filters. Press to unpin' : 'Pin: keep it listed whatever the time window or filters'
}

/** Every Pin toggle for a session (card, panel) shows its state in place, so focus and the card stay where they are. */
function syncPinButtons(key) {
  for (const button of document.querySelectorAll(`[data-action="pin"][data-key="${CSS.escape(key)}"]`)) {
    button.setAttribute('aria-pressed', String(isPinned(key)))
    button.title = pinTitle(key)
  }
}

/** Pin or unpin a session for every window and the pane (prefs.pinned), with Undo. */
async function togglePin(key) {
  const before = state.prefs?.pinned ?? []
  const wasPinned = before.includes(key)
  const next = wasPinned ? before.filter(k => k !== key) : [...before, key]
  const title = truncate(state.lookup?.sessions.get(key)?.title ?? 'The session', 40)
  if (!(await patchPrefs({ pinned: next }))) return
  syncPinButtons(key)
  toast(`“${title}” ${wasPinned ? 'unpinned' : 'pinned: it stays listed whatever the filters'}.`, async () => {
    await patchPrefs({ pinned: before })
    syncPinButtons(key)
  }, null, key)
}

/** Done, Snooze or Hide through the shared prefs, so the page, the pane and the counts agree; each with Undo. */
export async function triage(action, key) {
  const s = state.lookup?.sessions.get(key)
  if (!s) return
  const now = Date.now()
  const title = `“${truncate(s.title, 40)}”`
  let patch
  let undo
  let text
  if (action === 'done') {
    patch = donePatch(key, now)
    undo = donePatch(key, null)
    text = `${title} marked done.`
  } else if (action === 'snooze-hour' || action === 'snooze-tomorrow') {
    const until = snoozeUntil(action === 'snooze-hour' ? 'hour' : 'tomorrow', now)
    patch = snoozePatch(key, until, now)
    undo = snoozePatch(key, null, now)
    text = `${title} snoozed until ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${action === 'snooze-tomorrow' ? ' tomorrow' : ''}.`
  } else {
    if (bucketOf(s) === 'needs-you') return toast('A session that needs you can’t be hidden: use Done or Snooze.')
    const hidden = state.prefs?.hidden ?? {}
    patch = { hidden: { ...hidden, [key]: s.lastActivityAt } }
    undo = { hidden: Object.fromEntries(Object.entries(hidden).filter(([k]) => k !== key)) }
    text = `${title} hidden until it is active again.`
  }
  try {
    const answer = await post('/api/prefs', patch)
    if (answer?.prefs) state.prefs = sanitizePrefs(answer.prefs)
    toast(text, async () => {
      try {
        const back = await post('/api/prefs', undo)
        if (back?.prefs) state.prefs = sanitizePrefs(back.prefs)
      } catch (error) {
        toast(isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : 'Couldn’t undo it. Try again.')
      }
    }, null, key)
  } catch (error) {
    toast(isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : `Couldn’t ${action === 'done' ? 'mark it done' : action === 'hide' ? 'hide it' : 'snooze it'}. Try again.`)
  }
}

export async function openInClaude(key, { quiet = false } = {}) {
  const s = state.lookup?.sessions.get(key)
  if (!s?.canOpen) return toast('This session runs in a terminal: switch to it there.')
  try {
    const answer = await post('/api/open', { localId: s.localId })
    toast(answer?.dryRun ? `Dry run: would open “${truncate(s.title, 40)}”.` : `Opening “${truncate(s.title, 40)}” in Claude…`, null, null, key)
  } catch (error) {
    const link = handOffLink(error.detail)
    if (link) {
      location.assign(link)
      return toast(`Opening “${truncate(s.title, 40)}” in Claude… If Edge asks, allow it to open Claude.`, null, null, key)
    }
    const text = isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : 'Couldn’t open it in Claude desktop.'
    if (quiet) return text
    toast(text)
  }
  return null
}
