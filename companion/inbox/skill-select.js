import { el } from './ctx.js'
import { icon, skillIcon } from './icons.js'

const TYPE_AHEAD_MS = 600

/**
 * A single-choice skill picker: a button that opens a listbox of the shelf's skills, each with its icon.
 * `value` is the chosen command, '' for None; `onChange` runs after the user picks.
 * @param {{ id: string, onChange: () => void }} options
 */
export function skillSelect({ id, onChange }) {
  const listId = `${id}-list`
  const button = el('button', { id, class: 'cx-ss', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId })
  const list = el('div', { id: listId, class: 'cx-ss-list', popover: 'auto', role: 'listbox', tabindex: '-1' })
  let items = []
  let value = ''
  let active = 0
  let typed = ''
  let typedAt = 0
  let isDisabled = false

  const choices = () => [{ command: '', label: 'None' }, ...items.flatMap(g => g.items)]
  const chosen = () => choices().find(c => c.command === value) ?? choices()[0]

  function drawButton() {
    const item = chosen()
    button.replaceChildren(value ? skillIcon(item) : el('span', { class: 'cx-ss-blank', 'aria-hidden': 'true' }), el('span', { class: 'cx-ss-text' }, item.label), icon('down', 'cx-ss-caret'))
  }

  function optionRow(item, index) {
    return el(
      'div',
      { id: `${listId}-${index}`, class: 'cx-ss-opt', role: 'option', 'aria-selected': String(item.command === value), onmousedown: e => e.preventDefault(), onmousemove: () => index !== active && mark(index), onclick: () => choose(index) },
      item.command ? skillIcon(item) : el('span', { class: 'cx-ss-blank', 'aria-hidden': 'true' }),
      el('span', { class: 'cx-ss-text' }, item.label),
    )
  }

  function drawList() {
    let index = 0
    const none = optionRow(choices()[0], index++)
    list.replaceChildren(
      none,
      ...items.map(g => el('div', { class: 'cx-ss-group', role: 'group', 'aria-label': g.name }, el('div', { class: 'cx-ss-group-name', 'aria-hidden': 'true' }, g.name), ...g.items.map(item => optionRow(item, index++)))),
    )
  }

  function mark(index) {
    const rows = list.querySelectorAll('.cx-ss-opt')
    active = Math.max(0, Math.min(index, rows.length - 1))
    rows.forEach((row, i) => row.classList.toggle('is-active', i === active))
    const row = rows[active]
    if (!row) return list.removeAttribute('aria-activedescendant')
    list.setAttribute('aria-activedescendant', row.id)
    row.scrollIntoView({ block: 'nearest' })
  }

  function place() {
    const box = button.getBoundingClientRect()
    const style = list.style
    style.minWidth = `${box.width}px`
    const height = list.offsetHeight
    const isBelow = window.innerHeight - box.bottom - 8 >= height || box.top < height + 8
    style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - list.offsetWidth - 8))}px`
    style.top = `${isBelow ? box.bottom + 4 : box.top - height - 4}px`
  }

  function open() {
    drawList()
    list.showPopover()
    button.setAttribute('aria-expanded', 'true')
    place()
    list.focus()
    mark(choices().findIndex(c => c.command === value))
  }

  function close(shouldFocus) {
    if (list.matches(':popover-open')) list.hidePopover()
    if (shouldFocus) button.focus()
  }

  function choose(index) {
    const item = choices()[index]
    close(true)
    if (!item || item.command === value) return
    value = item.command
    drawButton()
    onChange()
  }

  function typeAhead(char) {
    const now = Date.now()
    typed = now - typedAt > TYPE_AHEAD_MS ? char : typed + char
    typedAt = now
    const isRepeat = [...typed].every(c => c === typed[0])
    const want = isRepeat ? typed[0] : typed
    const all = choices()
    const from = isRepeat ? active + 1 : active
    for (let step = 0; step < all.length; step += 1) {
      const index = (from + step) % all.length
      if (all[index].label.toLowerCase().startsWith(want)) return mark(index)
    }
  }

  let wasOpen = false
  button.addEventListener('pointerdown', () => (wasOpen = list.matches(':popover-open')))
  button.addEventListener('click', () => {
    if (isDisabled) return
    const isClosing = wasOpen || list.matches(':popover-open')
    wasOpen = false
    if (isClosing) close(true)
    else open()
  })
  button.addEventListener('keydown', event => {
    if (isDisabled || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    event.preventDefault()
    open()
  })
  list.addEventListener('toggle', event => event.newState === 'closed' && button.setAttribute('aria-expanded', 'false'))
  list.addEventListener('keydown', event => {
    const count = choices().length
    const moves = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: count - 1, PageDown: active + 8, PageUp: active - 8 }
    if (event.key in moves) {
      event.preventDefault()
      return mark(moves[event.key])
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      return choose(active)
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      return close(true)
    }
    if (event.key === 'Tab') return close(false)
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      typeAhead(event.key.toLowerCase())
    }
  })
  list.addEventListener('focusout', event => !list.contains(/** @type {Node} */ (event.relatedTarget)) && close(false))
  drawButton()

  return {
    button,
    list,
    get value() {
      return value
    },
    set value(next) {
      value = choices().some(c => c.command === next) ? next : ''
      drawButton()
    },
    /** A disabled picker stays visible and focusable but does not open. */
    set disabled(next) {
      isDisabled = next === true
      button.setAttribute('aria-disabled', String(isDisabled))
      if (isDisabled) close(false)
    },
    /** @param {{ name: string, items: { command: string, label: string, icon?: string, color?: string }[] }[]} groups */
    fill(groups) {
      items = groups
      if (!choices().some(c => c.command === value)) value = ''
      drawButton()
      if (list.matches(':popover-open')) close(false)
    },
  }
}
