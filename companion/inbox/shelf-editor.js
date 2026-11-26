import { MAX_MESSAGE_CHARS } from '/shared/constants.js'
import { isCommandAllowed } from '/shared/inbox.js'
import { addShelfGroup, addShelfItems, catalogPicks, editShelfGroup, editShelfItem, pageSlice, SHELF_MAX_GROUPS, SHELF_NAME_MAX, shelfCount, shelfRoom, SKILL_COLORS, SKILL_ICONS } from '/shared/skills.js'
import { $, api, el } from './ctx.js'
import { icon, skillIcon } from './icons.js'
import { dialogHead, openDialog, say } from './sheets.js'

const GROUPS_PER_PAGE = 8
const SKILLS_PER_PAGE = 10
const ICON_COLUMNS = 6

let host = null
let parts = null
let catalog = { status: 'idle', commands: [] }
let groupPage = 0
const skillPages = new Map()
const openGroups = new Set()
const queries = new Map()
const openTemplates = new Set()
const pickerResults = new Map()
let iconFor = null

/**
 * Builds the Settings "Skills" row: one button that opens the Skills editor.
 * @param {{ prefs: () => any, patchPrefs: (patch: object) => Promise<boolean> }} deps
 * @returns {HTMLElement}
 */
export function shelfSection(deps) {
  host = deps
  return el(
    'section',
    { 'aria-labelledby': 'cx-s-skills' },
    el('h3', { id: 'cx-s-skills' }, icon('skill', 'accent'), el('span', { class: 'h-title' }, 'Skills')),
    el('div', { class: 'cx-row-actions' }, el('button', { class: 'small', type: 'button', id: 'cx-s-skills-edit', onclick: () => openShelfEditor() }, 'Edit skills')),
  )
}

/**
 * Opens the Skills editor dialog over whatever is open.
 * @param {string} [fallback] the control focus returns to when the one that opened it is gone
 */
export function openShelfEditor(fallback = 'cx-s-skills-edit') {
  if (!parts) build()
  render()
  if (catalog.status === 'idle' || catalog.status === 'failed') void loadCatalog()
  openDialog(parts.dialog, parts.body.querySelector('[data-focus$=":toggle"]') ?? parts.addGroup, fallback)
}

/**
 * Redraws the open editor from the saved shelf. Skipped while focus is inside
 * it, so a live prefs update never wipes what is being typed.
 */
export function syncShelf() {
  if (!parts?.dialog.open || parts.dialog.contains(document.activeElement)) return
  render()
}

async function loadCatalog() {
  if (catalog.status === 'loading') return
  catalog = { status: 'loading', commands: catalog.commands }
  let answer = null
  try {
    answer = await api('GET', '/api/commands/catalog')
  } catch {
    answer = null
  }
  catalog = Array.isArray(answer?.commands) ? { status: 'ready', commands: answer.commands } : { status: 'failed', commands: [] }
  refreshPickers()
}

function build() {
  const dialog = $('cx-shelf-edit')
  const body = el('div', { class: 'cx-shelf', id: 'cx-shelf' })
  const pager = el('div', { class: 'cx-shelf-pager' })
  const addGroup = el('button', { class: 'small', type: 'button', id: 'cx-shelf-new', 'data-focus': 'new-group', onclick: newGroup }, icon('plus'), 'New group')
  const iconPanel = el('div', { class: 'cx-icon-pop', id: 'cx-icon-pop', popover: 'auto', role: 'dialog', 'aria-label': 'Choose an icon' })
  iconPanel.addEventListener('keydown', iconKey)
  iconPanel.addEventListener('toggle', event => {
    if (event.newState === 'open') return
    triggerFor(iconFor)?.setAttribute('aria-expanded', 'false')
    iconFor = null
  })
  dialog.replaceChildren(dialogHead('cx-shelf-edit-title', 'Skills', dialog), el('div', { class: 'cx-dialog-body' }, body, pager, el('div', { class: 'cx-row-actions' }, addGroup)), iconPanel)
  dialog.addEventListener('scroll', placeShownMenus, true)
  window.addEventListener('resize', placeShownMenus)
  parts = { dialog, body, pager, addGroup, iconPanel }
}

function shelf() {
  return host.prefs()?.skillShelf ?? { groups: [] }
}

async function save(next, message) {
  const isSaved = await host.patchPrefs({ skillShelf: next })
  if (!isSaved) return false
  render()
  if (message) say(message)
  return true
}

function render() {
  const active = document.activeElement
  const focusKey = parts.dialog.contains(active) ? active?.dataset?.focus : null
  const typing = focusKey && 'value' in active && 'selectionStart' in active ? { value: active.value, start: active.selectionStart, end: active.selectionEnd } : null
  const groups = shelf().groups
  const total = shelfCount(shelf())
  parts.addGroup.disabled = groups.length >= SHELF_MAX_GROUPS
  parts.addGroup.title = parts.addGroup.disabled ? `At most ${SHELF_MAX_GROUPS} groups.` : ''
  pickerResults.clear()
  const view = pageSlice(groups, groupPage, GROUPS_PER_PAGE)
  groupPage = view.page
  parts.body.replaceChildren(...view.items.map((group, i) => groupBlock(group, view.start + i, groups.length, total)))
  parts.pager.replaceChildren(...pagerParts(view, 'Groups', 'groups', page => (groupPage = page)))
  if (focusKey) refocus(focusKey, typing)
}

function refocus(focusKey, typing) {
  const find = key => parts.dialog.querySelector(`[data-focus="${CSS.escape(key)}"]`)
  const twin = { up: 'down', down: 'up', prev: 'next', next: 'prev' }
  let target = find(focusKey)
  if (!target || target.disabled) target = find(focusKey.replace(/:(up|down|prev|next)$/, (_, d) => `:${twin[d]}`)) ?? target
  if (!target || target.disabled) target = parts.addGroup
  target.focus()
  if (typing && target.value !== typing.value && 'selectionStart' in target) {
    target.value = typing.value
    target.setSelectionRange(typing.start, typing.end)
  }
}

function pagerParts(view, label, focus, go) {
  if (view.pages <= 1) return []
  const turn = (step, name) =>
    el(
      'button',
      { class: `icon-btn ghost cx-pager-${name}`, type: 'button', 'aria-label': `${name === 'prev' ? 'Previous' : 'Next'} ${label.toLowerCase()} page`, 'data-focus': `${focus}:${name}`, disabled: name === 'prev' ? view.page === 0 : view.page === view.pages - 1, onclick: () => (go(view.page + step), render()) },
      icon('chevron'),
    )
  return [el('div', { class: 'cx-pager', role: 'group', 'aria-label': `${label} pages` }, turn(-1, 'prev'), el('span', {}, `${view.page + 1} / ${view.pages}`), turn(1, 'next'))]
}

function groupBlock(group, at, count, total) {
  const isOpen = openGroups.has(group.id)
  const bodyId = `cx-shelf-g-${group.id}`
  const toggle = el(
    'button',
    { class: 'icon-btn ghost cx-shelf-toggle', type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': bodyId, 'aria-label': group.name, 'data-focus': `g:${group.id}:toggle` },
    icon('chevron'),
  )
  toggle.addEventListener('click', () => {
    if (openGroups.has(group.id)) openGroups.delete(group.id)
    else openGroups.add(group.id)
    render()
  })
  const name = el('input', { type: 'text', class: 'cx-shelf-name', maxlength: SHELF_NAME_MAX, 'aria-label': 'Group name', 'data-focus': `g:${group.id}:name`, spellcheck: 'false' })
  name.value = group.name
  name.addEventListener('change', () => {
    if (name.value.trim() === '') return void (name.value = group.name)
    void save(editShelfGroup(shelf(), group.id, { name: name.value }), 'Group renamed.')
  })
  const head = el(
    'div',
    { class: 'cx-shelf-head' },
    toggle,
    icon('folder', 'accent'),
    name,
    el('span', { class: 'cx-shelf-count', 'aria-label': `${group.items.length} skill${group.items.length === 1 ? '' : 's'}` }, String(group.items.length)),
    moveButton('up', `Move ${group.name} up`, `g:${group.id}:up`, at === 0, () => ((groupPage = Math.floor((at - 1) / GROUPS_PER_PAGE)), editShelfGroup(shelf(), group.id, { move: -1 }))),
    moveButton('down', `Move ${group.name} down`, `g:${group.id}:down`, at === count - 1, () => ((groupPage = Math.floor((at + 1) / GROUPS_PER_PAGE)), editShelfGroup(shelf(), group.id, { move: 1 }))),
    removeGroupButton(group),
  )
  if (!isOpen) return el('div', { class: 'cx-shelf-group', role: 'group', 'aria-label': group.name }, head)
  const view = pageSlice(group.items, skillPages.get(group.id) ?? 0, SKILLS_PER_PAGE)
  skillPages.set(group.id, view.page)
  return el(
    'div',
    { class: 'cx-shelf-group', role: 'group', 'aria-label': group.name, 'data-open': 'true' },
    head,
    el(
      'div',
      { class: 'cx-shelf-gbody', id: bodyId },
      view.items.length ? el('ul', { class: 'cx-shelf-items' }, ...view.items.map((item, i) => itemRow(group, item, view.start + i))) : null,
      ...pagerParts(view, 'Skills', `g:${group.id}:skills`, page => skillPages.set(group.id, page)),
      picker(group, total),
    ),
  )
}

function removeGroupButton(group) {
  const removeLabel = `Delete group ${group.name}`
  const remove = el('button', { class: 'icon-btn ghost cx-shelf-danger', type: 'button', 'aria-label': removeLabel, title: removeLabel, 'data-focus': `g:${group.id}:remove` }, icon('close'))
  remove.addEventListener('click', () => {
    if (group.items.length && remove.dataset.armed !== 'true') {
      const confirm = `Delete ${group.items.length} skill${group.items.length === 1 ? '' : 's'}?`
      remove.dataset.armed = 'true'
      remove.classList.replace('icon-btn', 'small')
      remove.setAttribute('aria-label', confirm)
      remove.textContent = confirm
      return
    }
    openGroups.delete(group.id)
    void save(editShelfGroup(shelf(), group.id, { remove: true }), `Deleted ${group.name}.`)
  })
  remove.addEventListener('blur', () => {
    if (remove.dataset.armed !== 'true') return
    delete remove.dataset.armed
    remove.classList.replace('small', 'icon-btn')
    remove.setAttribute('aria-label', removeLabel)
    remove.replaceChildren(icon('close'))
  })
  return remove
}

function moveButton(direction, label, focus, isEdge, next) {
  return el('button', { class: 'icon-btn ghost', type: 'button', 'aria-label': label, title: label, 'data-focus': focus, disabled: isEdge, onclick: () => void save(next()) }, icon(direction))
}

function itemRow(group, item, at) {
  const key = `${group.id}\n${item.command}`
  const focus = `i:${group.id}:${item.command}`
  const label = el('input', { type: 'text', class: 'cx-shelf-label', maxlength: SHELF_NAME_MAX, 'aria-label': `Name for /${item.command}`, 'data-focus': `${focus}:label`, spellcheck: 'false' })
  label.value = item.label
  label.addEventListener('change', () => void save(editShelfItem(shelf(), group.id, item.command, { label: label.value }), 'Skill renamed.'))
  const template = el('textarea', { class: 'cx-shelf-template', rows: 3, maxlength: MAX_MESSAGE_CHARS, 'aria-label': `Saved prompt for ${item.label}`, 'data-focus': `${focus}:template` })
  template.value = item.template ?? ''
  template.addEventListener('change', () => void save(editShelfItem(shelf(), group.id, item.command, { template: template.value }), template.value.trim() ? 'Saved prompt updated.' : 'Saved prompt cleared.'))
  const isTemplateOpen = openTemplates.has(key)
  const savedLabel = `Saved prompt for ${item.label}`
  const saved = el(
    'button',
    { class: 'icon-btn ghost cx-shelf-saved', type: 'button', 'aria-label': savedLabel, title: 'Saved prompt', 'aria-expanded': String(isTemplateOpen), 'data-set': item.template ? 'true' : null, 'data-focus': `${focus}:saved` },
    icon('edit'),
  )
  saved.addEventListener('click', () => {
    if (openTemplates.has(key)) openTemplates.delete(key)
    else openTemplates.add(key)
    render()
    if (openTemplates.has(key)) parts.dialog.querySelector(`[data-focus="${CSS.escape(`${focus}:template`)}"]`)?.focus()
  })
  const last = group.items.length - 1
  const follow = step => () => (skillPages.set(group.id, Math.floor((at + step) / SKILLS_PER_PAGE)), editShelfItem(shelf(), group.id, item.command, { move: step }))
  return el(
    'li',
    { class: 'cx-shelf-item' },
    el(
      'div',
      { class: 'cx-shelf-row' },
      iconButton(group, item, focus),
      label,
      el('code', { class: 'cx-k-command cx-shelf-command', title: `/${item.command}` }, `/${item.command}`),
      saved,
      moveButton('up', `Move ${item.label} up`, `${focus}:up`, at === 0, follow(-1)),
      moveButton('down', `Move ${item.label} down`, `${focus}:down`, at === last, follow(1)),
      el('button', { class: 'icon-btn ghost', type: 'button', 'aria-label': `Remove ${item.label}`, title: `Remove ${item.label}`, 'data-focus': `${focus}:remove`, onclick: () => void save(editShelfItem(shelf(), group.id, item.command, { remove: true }), `Removed ${item.label}.`) }, icon('close')),
    ),
    isTemplateOpen ? template : null,
  )
}

function iconButton(group, item, focus) {
  const isOpen = iconFor?.groupId === group.id && iconFor.command === item.command
  const what = `${item.color ? SKILL_COLORS[item.color] : 'Grey'} ${(SKILL_ICONS[item.icon] ?? SKILL_ICONS.skill).toLowerCase()}`
  return el(
    'button',
    {
      class: 'icon-btn ghost cx-shelf-icon',
      type: 'button',
      'aria-label': `Icon for ${item.label}: ${what}`,
      title: `Icon: ${what}`,
      'aria-haspopup': 'dialog',
      'aria-expanded': String(isOpen),
      'aria-controls': 'cx-icon-pop',
      'data-focus': `${focus}:icon`,
      onclick: () => toggleIconPanel({ groupId: group.id, command: item.command, focus: `${focus}:icon` }),
    },
    skillIcon(item),
  )
}

function triggerFor(target) {
  return target ? parts.dialog.querySelector(`[data-focus="${CSS.escape(target.focus)}"]`) : null
}

function iconItem() {
  if (!iconFor) return null
  return shelf().groups.find(g => g.id === iconFor.groupId)?.items.find(i => i.command === iconFor.command) ?? null
}

function toggleIconPanel(target) {
  const panel = parts.iconPanel
  if (iconFor?.focus === target.focus && panel.matches(':popover-open')) return panel.hidePopover()
  if (panel.matches(':popover-open')) panel.hidePopover()
  iconFor = target
  if (!drawIconPanel()) return
  panel.showPopover()
  triggerFor(target)?.setAttribute('aria-expanded', 'true')
  placeIconPanel()
  panel.querySelector('.cx-icon-cell[aria-pressed="true"]')?.focus()
}

function drawIconPanel() {
  const item = iconItem()
  if (!item) {
    if (parts.iconPanel.matches(':popover-open')) parts.iconPanel.hidePopover()
    return false
  }
  const shown = item.icon ?? 'skill'
  const colors = [['', 'Grey'], ...Object.entries(SKILL_COLORS)].map(([key, name]) =>
    el(
      'button',
      { class: 'cx-icon-swatch', type: 'button', 'aria-label': name, title: name, 'aria-pressed': String((item.color ?? '') === key), 'data-focus': `pop:c:${key || 'grey'}`, onclick: () => void pickIcon({ color: key }, false) },
      el('span', { class: key ? `cx-icon-dot c-${key}` : 'cx-icon-dot' }),
    ),
  )
  const cells = Object.entries(SKILL_ICONS).map(([key, name]) =>
    el(
      'button',
      { class: 'icon-btn ghost cx-icon-cell', type: 'button', 'aria-label': name, title: name, 'aria-pressed': String(shown === key), 'data-focus': `pop:i:${key}`, onclick: () => void pickIcon({ icon: key }, true) },
      skillIcon({ icon: key, color: item.color }),
    ),
  )
  parts.iconPanel.setAttribute('aria-label', `Icon for ${item.label}`)
  parts.iconPanel.replaceChildren(
    el('div', { class: 'cx-icon-colors', role: 'group', 'aria-label': 'Colour' }, ...colors),
    el('div', { class: 'cx-icon-grid', role: 'group', 'aria-label': 'Icon' }, ...cells),
  )
  return true
}

function placeIconPanel() {
  const trigger = triggerFor(iconFor)
  const panel = parts.iconPanel
  if (!trigger || !panel.matches(':popover-open')) return
  const box = trigger.getBoundingClientRect()
  const width = panel.offsetWidth
  const height = panel.offsetHeight
  const style = panel.style
  style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`
  const isBelow = window.innerHeight - box.bottom - 8 >= height || box.top < height + 8
  style.top = `${isBelow ? box.bottom + 4 : box.top - height - 4}px`
}

async function pickIcon(change, isDone) {
  const target = iconFor
  if (!target) return
  const isSaved = await save(editShelfItem(shelf(), target.groupId, target.command, change))
  if (!isSaved || iconFor !== target) return
  if (isDone) {
    parts.iconPanel.hidePopover()
    triggerFor(target)?.focus()
    return
  }
  drawIconPanel()
  triggerFor(target)?.setAttribute('aria-expanded', 'true')
  placeIconPanel()
  parts.iconPanel.querySelector(`[data-focus="pop:c:${change.color || 'grey'}"]`)?.focus()
}

function iconKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    const target = iconFor
    parts.iconPanel.hidePopover()
    triggerFor(target)?.focus()
    return
  }
  const from = event.target.closest?.('.cx-icon-swatch, .cx-icon-cell')
  if (!from) return
  const isCell = from.classList.contains('cx-icon-cell')
  const swatches = [...parts.iconPanel.querySelectorAll('.cx-icon-swatch')]
  const cells = [...parts.iconPanel.querySelectorAll('.cx-icon-cell')]
  const set = isCell ? cells : swatches
  const at = set.indexOf(from)
  const across = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
  let to = null
  if (across) to = set[(at + across + set.length) % set.length]
  else if (event.key === 'Home') to = set[0]
  else if (event.key === 'End') to = set.at(-1)
  else if (event.key === 'ArrowDown') to = isCell ? cells[at + ICON_COLUMNS] ?? null : cells.find(c => c.getAttribute('aria-pressed') === 'true') ?? cells[0]
  else if (event.key === 'ArrowUp') to = isCell ? (at < ICON_COLUMNS ? swatches.find(c => c.getAttribute('aria-pressed') === 'true') ?? swatches[0] : cells[at - ICON_COLUMNS]) : null
  else return
  event.preventDefault()
  to?.focus()
}

function picker(group, total) {
  const listId = `cx-shelf-menu-${group.id}`
  const search = el('input', {
    type: 'search',
    class: 'cx-shelf-search',
    placeholder: 'Add skills',
    autocomplete: 'off',
    spellcheck: 'false',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': listId,
    'aria-label': `Add skills to ${group.name}`,
    'data-focus': `g:${group.id}:search`,
  })
  search.value = queries.get(group.id) ?? ''
  const list = el('ul', { class: 'cx-shelf-menu', id: listId, role: 'listbox', popover: 'manual', 'aria-label': `Skills to add to ${group.name}` })
  const entry = { group, total, search, list, options: [], active: 0 }
  search.addEventListener('focus', () => showMenu(entry))
  search.addEventListener('click', () => showMenu(entry))
  search.addEventListener('blur', () => hideMenu(entry))
  search.addEventListener('input', () => {
    queries.set(group.id, search.value)
    entry.active = 0
    showMenu(entry)
  })
  search.addEventListener('keydown', event => menuKey(entry, event))
  pickerResults.set(group.id, entry)
  return el('div', { class: 'cx-shelf-add' }, icon('plus'), search, list)
}

function refreshPickers() {
  for (const entry of pickerResults.values()) if (document.activeElement === entry.search) showMenu(entry)
}

function isMenuShown(entry) {
  return entry.list.matches(':popover-open')
}

function showMenu(entry) {
  drawPicks(entry)
  if (!entry.search.isConnected || document.activeElement !== entry.search || entry.options.length === 0) return hideMenu(entry)
  if (!isMenuShown(entry)) entry.list.showPopover()
  entry.search.setAttribute('aria-expanded', 'true')
  placeMenu(entry)
}

function hideMenu(entry) {
  if (isMenuShown(entry)) entry.list.hidePopover()
  entry.search.setAttribute('aria-expanded', 'false')
  entry.search.removeAttribute('aria-activedescendant')
}

function placeMenu(entry) {
  const box = entry.search.getBoundingClientRect()
  const below = window.innerHeight - box.bottom - 8
  const above = box.top - 8
  const style = entry.list.style
  style.left = `${box.left}px`
  style.width = `${box.width}px`
  if (below >= 160 || below >= above) {
    style.top = `${box.bottom + 4}px`
    style.bottom = 'auto'
    style.maxHeight = `${Math.min(280, below)}px`
  } else {
    style.top = 'auto'
    style.bottom = `${window.innerHeight - box.top + 4}px`
    style.maxHeight = `${Math.min(280, above)}px`
  }
}

function placeShownMenus() {
  for (const entry of pickerResults.values()) if (isMenuShown(entry)) placeMenu(entry)
  if (iconFor) placeIconPanel()
}

function menuKey(entry, event) {
  const count = entry.options.length
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!isMenuShown(entry)) return showMenu(entry)
    if (count) entry.active = (entry.active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
    markActive(entry)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (isMenuShown(entry)) entry.options[entry.active]?.run()
  } else if (event.key === 'Escape' && isMenuShown(entry)) {
    event.preventDefault()
    event.stopPropagation()
    hideMenu(entry)
  }
}

function markActive(entry) {
  const rows = entry.list.children
  for (let i = 0; i < rows.length; i++) rows[i].setAttribute('aria-selected', String(i === entry.active))
  const active = rows[entry.active]
  if (!active) return entry.search.removeAttribute('aria-activedescendant')
  entry.search.setAttribute('aria-activedescendant', active.id)
  active.scrollIntoView({ block: 'nearest' })
}

function drawPicks(entry) {
  const { group, total, search, list } = entry
  const room = shelfRoom(group, total)
  const options = []
  if (room > 0) {
    const query = search.value
    const picks = catalogPicks(catalog.commands, group, query)
    const typed = query.trim().replace(/^\//, '')
    const isTypedNew = typed !== '' && isCommandAllowed(typed) && !group.items.some(i => i.command === typed) && !picks.matches.some(c => c.name === typed)
    for (const plugin of picks.plugins) {
      const n = Math.min(plugin.commands.length, room)
      options.push({ isPlugin: true, content: [el('span', { class: 'cx-shelf-opt-name' }, `Add all from ${plugin.plugin} (${n})`)], run: () => void add(group, plugin.commands, `from ${plugin.plugin}`) })
    }
    for (const command of picks.matches) {
      options.push({
        title: command.description || null,
        content: [el('span', { class: 'cx-shelf-opt-name' }, `/${command.name}`), command.description ? el('span', { class: 'cx-shelf-opt-desc' }, command.description) : null],
        run: () => void add(group, [command.name], `/${command.name}`),
      })
    }
    if (isTypedNew) options.push({ content: [el('span', { class: 'cx-shelf-opt-name' }, `/${typed}`)], run: () => void add(group, [typed], `/${typed}`) })
  }
  entry.options = options
  entry.active = Math.min(entry.active, Math.max(0, options.length - 1))
  list.replaceChildren(
    ...options.map((option, i) =>
      el(
        'li',
        {
          id: `${list.id}-${i}`,
          role: 'option',
          class: option.isPlugin ? 'cx-shelf-opt is-plugin' : 'cx-shelf-opt',
          'aria-selected': 'false',
          title: option.title ?? null,
          onmousedown: event => event.preventDefault(),
          onmousemove: () => {
            if (entry.active === i) return
            entry.active = i
            markActive(entry)
          },
          onclick: () => option.run(),
        },
        ...option.content,
      ),
    ),
  )
  markActive(entry)
}

async function add(group, commands, what) {
  const result = addShelfItems(shelf(), group.id, commands)
  if (!result.added) return say('Nothing added: already here, or Skills are full.')
  queries.delete(group.id)
  const skipped = result.skipped ? ` ${result.skipped} skipped.` : ''
  await save(result.shelf, `Added ${result.added === 1 ? what : `${result.added} skills ${what}`} to ${group.name}.${skipped}`)
  pickerResults.get(group.id)?.search.focus()
}

function newGroup() {
  const result = addShelfGroup(shelf(), 'New group')
  if (!result) return say(`At most ${SHELF_MAX_GROUPS} groups.`)
  openGroups.add(result.id)
  groupPage = Math.floor((result.shelf.groups.length - 1) / GROUPS_PER_PAGE)
  void save(result.shelf, 'Group added.').then(isSaved => {
    if (!isSaved) return
    const name = parts.dialog.querySelector(`[data-focus="${CSS.escape(`g:${result.id}:name`)}"]`)
    name?.focus()
    name?.select()
  })
}
