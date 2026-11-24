import { SESSION_TINTS, TITLE_MAX, tintKey } from '/shared/constants.js'
import { commandBlock, isNoWindow, NO_WINDOW_TEXT } from '/shared/popout.js'
import { cleanTitle, sanitizePrefs } from '/shared/prefs.js'
import { api, hooks } from './ctx.js'
import { icon } from './icons.js'
import { commandsFor } from './composer.js'
import { el, post, state } from './page-state.js'

export const TINT_NAMES = { blue: 'Blue', violet: 'Violet', pink: 'Pink', red: 'Red', teal: 'Teal', lime: 'Lime', sand: 'Sand', slate: 'Slate' }

let editing = null

/** Whether the panel head is showing the rename form for session `key`. */
export function isEditing(key) {
  return editing?.key === key
}

/** What the rename form shows, so the panel redraws it only when that changes. */
export function editingSignature() {
  return editing ? JSON.stringify(['edit', editing.key, editing.busy, editing.error]) : null
}

/** Closes the rename form without saving. */
export function stopEditing() {
  editing = null
}

/**
 * The name Orbit shows for `s`, counting a save the snapshot has not caught up with yet.
 * @param {{ key: string, title: string, renamedFrom?: string }} s
 */
export function titleOf(s) {
  if (!state.prefs) return s.title
  return state.prefs.titles?.[s.key] ?? s.renamedFrom ?? s.title
}

/**
 * The icon colour of `s`: its own choice, else its project's, else blue,
 * counting a save the snapshot has not caught up with yet.
 * @param {{ key: string, projectId?: string, tint?: string }} s
 */
export function tintOf(s) {
  if (!state.prefs) return s.tint ?? 'blue'
  return state.prefs.tints?.[s.key] ?? projectTintOf(s.projectId)
}

/**
 * The default icon colour of a project's sessions; `blue` when none was chosen.
 * @param {string | undefined} projectId
 */
export function projectTintOf(projectId) {
  if (!projectId) return 'blue'
  if (!state.prefs) return state.lookup?.projects.get(projectId)?.tint ?? 'blue'
  return state.prefs.projectTints?.[projectId] ?? 'blue'
}

/** The CSS colour of an icon tint. @param {string} tint */
export function tintColour(tint) {
  return `var(--${tintKey(tint).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)})`
}

/** The session's robot icon in its colour. */
export function robotIcon(s) {
  const span = icon('robot', 'cx-robot')
  span.style.color = tintColour(tintOf(s))
  return span
}

/**
 * Round colour swatches as a radio group. `follow`, when given, comes first:
 * a ring in the colour it stands for, chosen with the value `follow.value`.
 * @param {{ name: string, legend: string, current: string, follow?: { value: string, tint: string, label: string } | null, onPick: (value: string) => void }} options
 */
export function swatchGroup({ name, legend, current, follow = null, onPick }) {
  const swatch = (value, label, dot) =>
    el('label', { class: 'cx-swatch', title: label }, el('input', { type: 'radio', name, value, checked: value === current || null, 'aria-label': label, onchange: () => onPick(value) }), dot)
  return el(
    'fieldset',
    { class: 'cx-swatches' },
    el('legend', {}, legend),
    follow ? swatch(follow.value, follow.label, el('span', { class: 'cx-swatch-dot is-follow', style: `border-color: ${tintColour(follow.tint)}`, 'aria-hidden': 'true' })) : null,
    ...SESSION_TINTS.map(tint => swatch(tint, tint === 'blue' && !follow ? 'Blue (default)' : TINT_NAMES[tint], el('span', { class: `cx-swatch-dot t-${tint}`, 'aria-hidden': 'true' }))),
  )
}

function renameBlock(s) {
  const list = commandsFor(s.key)
  const listed = list?.known ? list.commands.some(c => c.name === 'rename') : null
  return commandBlock(s, { armed: hooks.isArmed('replies'), listed, name: 'rename', doing: 'rename it in Claude too' })
}

/**
 * Opens the rename form for `s` in the panel head.
 * @param {{ key: string }} s
 */
export function startEditing(s) {
  editing = { key: s.key, error: null, busy: false, draft: null, tint: null }
}

/**
 * The rename form: a name, the icon colour swatches, Save and Cancel, and
 * "Use desktop name" while Orbit's name differs from the desktop's.
 * @param {any} s
 * @param {{ done: (focusEdit: boolean) => void }} options `done` runs after a save or cancel, to redraw the head
 */
export function renameForm(s, { done }) {
  const original = s.renamedFrom ?? s.title
  const hasOwnName = state.prefs ? Boolean(state.prefs.titles?.[s.key]) : Boolean(s.renamedFrom)
  const input = el('input', { id: 'cx-ident-title', type: 'text', maxlength: String(TITLE_MAX), value: editing?.draft ?? titleOf(s), autocomplete: 'off', spellcheck: 'false' })
  input.addEventListener('input', () => {
    if (editing) editing.draft = input.value
  })
  const ownTint = state.prefs ? state.prefs.tints?.[s.key] : s.tint
  const projectTint = projectTintOf(s.projectId)
  const swatches = swatchGroup({
    name: 'cx-ident-tint',
    legend: 'Icon colour',
    current: editing?.tint ?? ownTint ?? FOLLOW,
    follow: { value: FOLLOW, tint: projectTint, label: `Project default (${TINT_NAMES[projectTint]})` },
    onPick: value => editing && (editing.tint = value),
  })
  const error = editing?.error ? el('p', { class: 'err', role: 'alert' }, editing.error) : null
  const cancel = () => {
    editing = null
    done(true)
  }
  const form = el(
    'form',
    { class: 'cx-ident', 'aria-label': 'Rename session' },
    el('label', { for: 'cx-ident-title', class: 'cx-ident-label' }, 'Name'),
    input,
    swatches,
    error,
    el(
      'div',
      { class: 'cx-ident-actions' },
      el('button', { type: 'submit', class: 'primary', disabled: editing?.busy || null }, editing?.busy ? 'Saving…' : 'Save'),
      el('button', { type: 'button', onclick: cancel }, 'Cancel'),
      hasOwnName ? el('button', { type: 'button', class: 'ghost', onclick: () => void save(s, null, chosenTint(form), done) }, 'Use desktop name') : null,
    ),
  )
  form.addEventListener('submit', event => {
    event.preventDefault()
    const typed = cleanTitle(input.value)
    void save(s, typed && typed !== original ? typed : null, chosenTint(form), done)
  })
  form.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  })
  queueMicrotask(() => {
    if (!input.isConnected) return
    input.focus({ preventScroll: true })
    input.select()
  })
  return form
}

const FOLLOW = 'project'

function chosenTint(form) {
  const value = form.querySelector('input[name="cx-ident-tint"]:checked')?.value ?? FOLLOW
  return value === FOLLOW ? null : value
}

/**
 * Saves the name (null: the desktop's) and colour (null: the project's) to prefs, then
 * asks the session to run `/rename` when the name changed and it can.
 */
async function save(s, title, tint, done) {
  if (!editing || editing.busy) return
  const before = state.prefs?.titles?.[s.key] ?? null
  editing.busy = true
  editing.error = null
  done(false)
  try {
    const answer = await post('/api/prefs', { titles: { [s.key]: title }, tints: { [s.key]: tint } })
    if (answer?.prefs) state.prefs = sanitizePrefs(answer.prefs)
  } catch (error) {
    if (editing) {
      editing.busy = false
      editing.error = isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : 'Couldn’t save it. Try again.'
    }
    done(false)
    return
  }
  editing = null
  done(true)
  if (!title || title === before || renameBlock(s)) return
  try {
    await api('POST', '/api/reply', { sessionKey: s.key, text: `/rename ${title}` })
  } catch (error) {
    hooks.status(`Renamed in Orbit only: ${error.message}`, true)
  }
}
