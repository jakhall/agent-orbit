import { filterPrChoices, prChoiceDetail, prChoiceTitle, prFromInput, prLinkOf } from '/shared/pr-links.js'
import { api, el } from './ctx.js'
import { icon } from './icons.js'

const STATUS_RETRIES = 4
const STATUS_RETRY_MS = 3_000
const STATUS_DEBOUNCE_MS = 250

/** @type {Record<string, import('../../types').PrStatus>} */
let statuses = {}

/**
 * The "Pull request (optional)" field: a text box that filters a list of the
 * offered PRs (title, then repository, number, state and branch) and takes a
 * pasted GitHub PR link. Picking a PR shows its title in the box.
 * @param {{ id: string, groups: { own: string, other: string }, onChange?: () => void, onEnter?: () => void }} options
 */
export function prPicker({ id, groups, onChange = () => {}, onEnter = () => {} }) {
  const listId = `${id}-list`
  const input = el('input', { id, type: 'text', autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId, placeholder: 'Pick one, type to search, or paste a link' })
  const toggle = el('button', { class: 'cx-pr-toggle', type: 'button', tabindex: '-1', 'aria-label': 'Show pull requests', title: 'Show pull requests' }, icon('down', 'cx-ss-caret'))
  const box = el('div', { class: 'cx-pr-box' }, input, toggle)
  const list = el('div', { id: listId, class: 'cx-ss-list cx-pr-list', popover: 'manual', role: 'listbox' })
  const detail = el('p', { class: 'cx-hint cx-pr-picked', hidden: true })
  /** @type {import('/shared/pr-links.js').PrChoice[]} */
  let choices = []
  /** @type {import('/shared/pr-links.js').PrChoice[]} */
  let shown = []
  /** @type {{ url: string, text: string } | null} */
  let picked = null
  let active = -1
  let fillSeq = 0
  let loadTimer = 0

  const statusOf = (/** @type {string} */ url) => (Object.hasOwn(statuses, url) ? statuses[url] : null)
  const isOpen = () => list.matches(':popover-open')

  function optionRow(choice, index) {
    const status = statusOf(choice.url)
    return el(
      'div',
      { id: `${listId}-${index}`, class: 'cx-ss-opt cx-pr-opt', role: 'option', 'aria-selected': String(picked?.url === choice.url), onmousedown: e => e.preventDefault(), onmousemove: () => index !== active && mark(index), onclick: () => choose(index) },
      el('span', { class: 'cx-pr-title' }, prChoiceTitle(choice, status)),
      el('span', { class: 'cx-pr-detail' }, prChoiceDetail(choice, status)),
    )
  }

  function drawList() {
    const text = picked && input.value === picked.text ? '' : input.value
    shown = filterPrChoices(choices, text, statuses)
    if (shown.length === 0) {
      list.replaceChildren(el('div', { class: 'cx-pr-empty' }, choices.length ? 'No match. Paste a GitHub pull request link.' : 'No pull requests linked here yet. Paste a GitHub pull request link.'))
      active = -1
      input.removeAttribute('aria-activedescendant')
      return
    }
    let index = 0
    const own = shown.filter(c => c.isSessions)
    const other = shown.filter(c => !c.isSessions)
    shown = [...own, ...other]
    const group = (/** @type {string} */ name, /** @type {typeof shown} */ items) => (items.length ? [el('div', { class: 'cx-ss-group', role: 'group', 'aria-label': name }, el('div', { class: 'cx-ss-group-name', 'aria-hidden': 'true' }, name), ...items.map(c => optionRow(c, index++)))] : [])
    list.replaceChildren(...group(groups.own, own), ...group(groups.other, other))
    mark(Math.max(0, shown.findIndex(c => c.url === picked?.url)))
  }

  function mark(index) {
    const rows = list.querySelectorAll('.cx-pr-opt')
    if (rows.length === 0) return
    active = Math.max(0, Math.min(index, rows.length - 1))
    rows.forEach((row, i) => row.classList.toggle('is-active', i === active))
    input.setAttribute('aria-activedescendant', rows[active].id)
    rows[active].scrollIntoView({ block: 'nearest' })
  }

  function place() {
    const rect = box.getBoundingClientRect()
    const style = list.style
    style.width = `${rect.width}px`
    const height = list.offsetHeight
    const isBelow = window.innerHeight - rect.bottom - 8 >= height || rect.top < height + 8
    style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - list.offsetWidth - 8))}px`
    style.top = `${isBelow ? rect.bottom + 4 : rect.top - height - 4}px`
  }

  function open() {
    if (!box.isConnected) return
    if (!picked && prLinkOf(input.value)) return close()
    drawList()
    if (!isOpen()) list.showPopover()
    input.setAttribute('aria-expanded', 'true')
    place()
  }

  function close() {
    if (isOpen()) list.hidePopover()
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
    active = -1
  }

  function drawPicked() {
    const choice = picked ? choices.find(c => c.url === picked.url) : null
    detail.textContent = choice ? prChoiceDetail(choice, statusOf(choice.url)) : ''
    detail.hidden = !choice
  }

  function choose(index) {
    const choice = shown[index]
    if (!choice) return
    picked = { url: choice.url, text: prChoiceTitle(choice, statusOf(choice.url)) }
    input.value = picked.text
    drawPicked()
    close()
    input.focus()
    onChange()
  }

  input.addEventListener('input', () => {
    if (picked && input.value !== picked.text) {
      picked = null
      drawPicked()
    }
    open()
    onChange()
  })
  input.addEventListener('click', () => (isOpen() ? close() : open()))
  toggle.addEventListener('mousedown', e => e.preventDefault())
  toggle.addEventListener('click', () => {
    input.focus()
    if (isOpen()) close()
    else open()
  })
  input.addEventListener('keydown', event => {
    if (event.isComposing) return
    const moves = { ArrowDown: active + 1, ArrowUp: active - 1, PageDown: active + 8, PageUp: active - 8 }
    if (event.key in moves) {
      event.preventDefault()
      if (!isOpen()) return open()
      return mark(moves[event.key])
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (isOpen() && active >= 0) return choose(active)
      close()
      return onEnter()
    }
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault()
      event.stopPropagation()
      return close()
    }
    if (event.key === 'Tab') close()
  })
  list.addEventListener('mousedown', e => e.preventDefault())
  input.addEventListener('blur', () => close())
  window.addEventListener('resize', () => isOpen() && place())

  function scheduleLoad(delay, tries) {
    clearTimeout(loadTimer)
    const seq = (fillSeq += 1)
    loadTimer = setTimeout(() => void loadStatuses(seq, tries), delay)
  }

  async function loadStatuses(seq, tries) {
    let answer = null
    try {
      answer = await api('GET', '/api/prs?want=1')
    } catch {
      answer = null
    }
    if (seq !== fillSeq || !box.isConnected) return
    if (answer?.statuses && typeof answer.statuses === 'object') statuses = answer.statuses
    if (picked) {
      const choice = choices.find(c => c.url === picked.url)
      const text = choice ? prChoiceTitle(choice, statusOf(choice.url)) : picked.text
      if (input.value === picked.text) input.value = text
      picked = { url: picked.url, text }
      drawPicked()
    }
    if (isOpen()) open()
    const isMissing = choices.some(c => !statusOf(c.url) && !answer?.unreadable?.includes(c.url))
    if (isMissing && tries > 1 && answer?.checks?.state !== 'unavailable') loadTimer = setTimeout(() => void loadStatuses(seq, tries - 1), STATUS_RETRY_MS)
  }

  return {
    input,
    /**
     * The field's row: label, box, the picked PR's details, `error` and the list.
     * @param {HTMLElement} error
     */
    row: error => el('div', { class: 'cx-field cx-wide cx-pr-field' }, el('label', { class: 'cx-field-label', for: id }, 'Pull request (optional)'), box, detail, error, list),
    /** The PR link the field names: '' when empty, null when it names none. */
    get value() {
      if (picked && input.value === picked.text) return picked.url
      return prFromInput(input.value, choices)
    },
    /** @param {import('/shared/pr-links.js').PrChoice[]} next */
    fill(next) {
      choices = next
      if (picked && !choices.some(c => c.url === picked.url)) clear()
      if (isOpen()) open()
      if (choices.length) scheduleLoad(STATUS_DEBOUNCE_MS, STATUS_RETRIES)
    },
    clear,
  }

  function clear() {
    picked = null
    input.value = ''
    drawPicked()
    close()
  }
}
