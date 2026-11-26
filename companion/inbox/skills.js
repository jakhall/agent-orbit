import { prChoices } from '/shared/pr-links.js'
import { shelfCount, shelfView, skillLine } from '/shared/skills.js'
import { MAX_MESSAGE_CHARS } from '/shared/constants.js'
import { $, api, el } from './ctx.js'
import { state } from './page-state.js'
import { icon, skillIcon } from './icons.js'
import { dialogHead, openDialog, say } from './sheets.js'
import { openShelfEditor } from './shelf-editor.js'
import { prPicker } from './pr-picker.js'

const closedGroups = new Set()
let parts = null
let current = null

function build() {
  const dialog = $('cx-skills')
  const filter = el('input', { id: 'cx-k-filter', type: 'search', placeholder: 'Filter skills', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Filter skills', 'aria-controls': 'cx-k-list' })
  const list = el('div', { id: 'cx-k-list', class: 'cx-k-list' })
  const edit = el('button', { class: 'icon-btn ghost', id: 'cx-k-edit', type: 'button', 'aria-label': 'Edit skills', title: 'Edit skills', 'aria-haspopup': 'dialog', onclick: editSkills }, icon('edit'))
  const browse = el('div', { class: 'cx-k-browse' }, el('div', { class: 'cx-k-tools' }, filter, edit), list)
  const chip = el('div', { class: 'cx-k-chip' })
  const prompt = el('textarea', { id: 'cx-k-prompt', rows: 4, maxlength: MAX_MESSAGE_CHARS })
  const apply = el('button', { class: 'primary', id: 'cx-k-apply', type: 'button', onclick: applyPicked }, 'Apply')
  const back = el('button', { class: 'ghost', type: 'button', onclick: () => showBrowse(true) }, 'Back')
  const pr = prPicker({ id: 'cx-k-pr', groups: { own: 'This session', other: 'Same repository' }, onChange: () => showPrError(null), onEnter: applyPicked })
  pr.input.setAttribute('aria-describedby', 'cx-k-pr-error')
  const prError = el('p', { class: 'err cx-field-error', id: 'cx-k-pr-error', hidden: true })
  const step = el(
    'div',
    { class: 'cx-k-apply', hidden: true },
    chip,
    el('label', { class: 'cx-field cx-wide' }, el('span', {}, 'Prompt (optional)'), prompt),
    pr.row(prError),
    el('div', { class: 'cx-row-actions cx-k-actions' }, back, apply),
  )
  filter.addEventListener('input', renderList)
  filter.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const first = list.querySelector('.cx-k-item:not([aria-disabled="true"])')
    first?.click()
  })
  prompt.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing) return
    event.preventDefault()
    applyPicked()
  })
  dialog.addEventListener('close', () => (current = null))
  dialog.replaceChildren(dialogHead('cx-skills-title', 'Apply skill', dialog), el('div', { class: 'cx-dialog-body' }, browse, step))
  parts = { dialog, filter, list, browse, step, chip, prompt, pr, prError, apply }
}

/**
 * Opens the explorer for session `s`. `send(key, line)` sends through the
 * composer and answers null when the line went, else why it did not.
 * @param {{ key: string, title?: string }} s
 * @param {(key: string, line: string) => string | null} send
 * @param {string | null} [command] opens at this skill's Apply step once the session's commands load
 */
export function openSkills(s, send, command = null) {
  if (!parts) build()
  current = { key: s.key, send, commands: null, picked: null, want: command }
  parts.filter.value = ''
  showBrowse(false)
  openDialog(parts.dialog, parts.filter, 'cx-convo')
  void loadCommands(s.key)
}

async function loadCommands(key) {
  let answer = null
  try {
    answer = await api('GET', `/api/commands?sessionKey=${encodeURIComponent(key)}`)
  } catch {
    answer = null
  }
  if (current?.key !== key) return
  current.commands = answer?.known === true && Array.isArray(answer.commands) ? answer.commands : null
  current.loaded = true
  const want = current.want
  current.want = null
  if (want) {
    const item = shelfView(state.prefs?.skillShelf, current.commands).flatMap(g => g.items).find(i => i.command === want)
    if (item?.available && !parts.browse.hidden) return pick(item)
    if (item?.reason) say(item.reason)
  }
  if (!parts.browse.hidden) renderList()
}

function showBrowse(isFocus) {
  if (current) current.picked = null
  parts.step.hidden = true
  parts.browse.hidden = false
  renderList()
  if (isFocus) parts.filter.focus()
}

function renderList() {
  if (!current) return
  const shelf = state.prefs?.skillShelf
  const total = shelfCount(shelf)
  if (total === 0) {
    parts.filter.hidden = true
    parts.list.replaceChildren()
    return
  }
  parts.filter.hidden = false
  const isLoading = !current.loaded
  const groups = shelfView(shelf, isLoading ? [] : current.commands, parts.filter.value)
  if (groups.length === 0) {
    parts.list.replaceChildren()
    return
  }
  const isFiltering = parts.filter.value.trim() !== ''
  parts.list.replaceChildren(
    ...groups.map(group => {
      const details = el('details', { class: 'cx-k-group', open: isFiltering || !closedGroups.has(group.id) || null })
      details.addEventListener('toggle', () => {
        if (isFiltering) return
        if (details.open) closedGroups.delete(group.id)
        else closedGroups.add(group.id)
      })
      details.append(
        el('summary', {}, el('span', { class: 'cx-k-group-name' }, group.name), el('span', { class: 'cx-k-count' }, String(group.items.length))),
        ...group.items.map(item => itemButton(item, isLoading)),
      )
      return details
    }),
  )
}

function itemButton(item, isLoading) {
  const reason = isLoading ? 'Loading this session’s commands…' : item.reason
  const isOff = !isLoading && !item.available
  return el(
    'button',
    {
      class: 'cx-k-item',
      type: 'button',
      title: isOff ? reason : null,
      'aria-disabled': isOff || isLoading ? 'true' : null,
      'aria-description': isOff ? reason : null,
      onclick: () => (isOff || isLoading ? say(reason ?? '') : pick(item)),
    },
    skillIcon(item),
    el('span', { class: 'cx-k-text' }, el('span', { class: 'cx-k-label' }, item.label), el('span', { class: 'cx-k-command' }, `/${item.command}`)),
  )
}

function pick(item) {
  current.picked = item
  parts.browse.hidden = true
  parts.step.hidden = false
  parts.chip.replaceChildren(skillIcon(item), el('span', { class: 'cx-k-label' }, item.label), el('code', { class: 'cx-k-command' }, `/${item.command}`))
  parts.prompt.value = item.template ?? ''
  parts.pr.clear()
  parts.pr.fill(prChoices(state.snapshot, { sessionKey: current.key }))
  showPrError(null)
  parts.prompt.focus()
  parts.prompt.setSelectionRange(parts.prompt.value.length, parts.prompt.value.length)
}

function applyPicked() {
  if (!current?.picked) return
  const prUrl = parts.pr.value
  if (prUrl === null) {
    showPrError('Not a GitHub pull request link.')
    return parts.pr.input.focus()
  }
  const line = skillLine(current.picked.command, parts.prompt.value, prUrl || null)
  if (!line) return say('Orbit cannot send this command.')
  const why = current.send(current.key, line)
  if (why) return say(why)
  parts.dialog.close()
}

function showPrError(text) {
  parts.prError.textContent = text ?? ''
  parts.prError.hidden = !text
  parts.pr.input.setAttribute('aria-invalid', text ? 'true' : 'false')
}

function editSkills() {
  parts.dialog.close()
  openShelfEditor('cx-convo')
}
