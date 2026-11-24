import { bucketOf, cardModel } from '/shared/map.js'
import { icon } from './icons.js'
import { $, el, state } from './page-state.js'
import { cardActions } from './actions.js'
import { panelLeft, stageBox } from './stage.js'

const CARD_DELAY_MS = 150
export let cardTimer = 0
/** Shows the card for the session under the pointer (or hides it) after a short pause, so passing over the map doesn't flicker. */
export function scheduleCard(key) {
  clearTimeout(cardTimer)
  if (key === state.cardKey) return
  cardTimer = setTimeout(() => showCard(key), key ? CARD_DELAY_MS : 300)
}

/** The hover and focus card (`cardModel`): the title with its actions, one status line, project and branch, and the ask or last report. */
export function showCard(key) {
  const card = $('cx-card')
  const s = key ? state.lookup?.sessions.get(key) : null
  const node = s ? state.visible?.nodes.find(n => n.id === `s:${key}`) : null
  if (!s || !node || !state.camera) {
    state.cardKey = null
    card.hidden = true
    return
  }
  state.cardKey = key
  const bucket = bucketOf(s)
  const model = cardModel(s, bucket, state.lookup, Date.now())
  card.replaceChildren(
    ...[
      el('div', { class: 'cx-card-head' }, el('p', { class: 'cx-card-title' }, model.head.title), cardActions(key, model.head.actions)),
      el('p', { class: 'cx-card-status' }, el('span', { class: `dot b-${bucket}`, 'aria-hidden': 'true' }), el('span', {}, model.status)),
      model.facts.length ? el('div', { class: 'cx-card-facts' }, ...model.facts.map(f => el('span', { class: 'cx-fact', title: f.label }, icon(f.icon, 'accent'), el('span', { class: 'sr-only' }, `${f.label.split(' · ')[0]}: `), el('span', {}, f.text)))) : null,
      model.body ? el('p', { class: 'cx-card-body' }, model.body) : null,
    ].filter(Boolean),
  )
  card.setAttribute('aria-label', s.title)
  const box = stageBox()
  const k = box.width / state.camera.w
  const x = (node.x - state.camera.x) * k
  const y = (node.y - state.camera.y) * k
  card.hidden = false
  for (const part of card.querySelectorAll('.cx-card-title, .cx-card-status > span:last-child, .cx-card-body')) titleIfClipped(part)
  const w = card.offsetWidth
  const h = card.offsetHeight
  const right = Math.min(box.width, panelLeft() ?? box.width) - 8
  if (x > right || x < 0 || y < 0 || y > box.height) {
    hideCard()
    return
  }
  const { left, top } = cardSpot({ x, y, w, h, right, bottom: box.height })
  card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
}

/** Gives `part` its own text as a tooltip only when an ellipsis or the line clamp cuts it. @param {Element} part */
function titleIfClipped(part) {
  if (part.scrollWidth > part.clientWidth + 1 || part.scrollHeight > part.clientHeight + 1) part.setAttribute('title', part.textContent ?? '')
}

function cardSpot({ x, y, w, h, right, bottom }) {
  const gap = 16
  const clampTop = top => Math.min(Math.max(8, top), bottom - h - 8)
  if (x + gap + w <= right) return { left: x + gap, top: clampTop(y - h / 2) }
  if (x - gap - w >= 8) return { left: x - gap - w, top: clampTop(y - h / 2) }
  const left = Math.min(Math.max(8, x - w / 2), right - w)
  const below = y + gap + h <= bottom - 8
  return { left: Math.max(8, left), top: below ? y + gap : Math.max(8, y - gap - h) }
}

export function hideCard() {
  clearTimeout(cardTimer)
  state.cardKey = null
  $('cx-card').hidden = true
}
