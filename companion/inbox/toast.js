import { $, el, state } from './page-state.js'
import { robotIcon } from './identity.js'

export let toastTimer = 0
export const toastState = { undo: null, origin: null, ms: 0 }
/** A short status line over the map, led by the session's icon when it is about one session; with Undo (button or u) when the action can be undone. It stays while hovered or focused, and gives focus back where it came from. */
export function toast(text, undo = null, action = null, sessionKey = null) {
  const inDialog = document.querySelector('dialog[open] .cx-dialog-status')
  if (inDialog && !undo) {
    inDialog.textContent = ''
    setTimeout(() => inDialog.replaceChildren(...[text, action ? el('button', { class: 'cx-link', onclick: () => (inDialog.closest('dialog')?.close(), action.run()) }, ` ${action.label}`) : null].filter(Boolean)), 50)
    return
  }
  const box = $('cx-toast')
  clearTimeout(toastTimer)
  toastState.undo = undo
  toastState.origin = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  toastState.ms = undo || action ? 8_000 : 4_000
  box.replaceChildren(
    ...[
      sessionKey ? robotIcon(state.lookup?.sessions.get(sessionKey) ?? { key: sessionKey }) : null,
      el('span', {}, undo ? `${text} Press u to undo.` : text),
      undo ? el('button', { onclick: () => void runUndo() }, 'Undo') : null,
      !undo && action ? el('button', { onclick: () => (closeToast(), action.run()) }, action.label) : null,
    ].filter(Boolean),
  )
  box.hidden = false
  armToast()
}

export function armToast() {
  clearTimeout(toastTimer)
  toastTimer = setTimeout(expireToast, toastState.ms)
}

function expireToast() {
  const box = $('cx-toast')
  if (box.hidden) return
  if (box.contains(document.activeElement) || box.matches(':hover')) return armToast()
  closeToast()
}

export function closeToast() {
  const box = $('cx-toast')
  const hadFocus = box.contains(document.activeElement)
  box.hidden = true
  toastState.undo = null
  if (hadFocus) originNow().focus({ preventScroll: true })
}

function originNow() {
  const origin = toastState.origin
  if (origin?.isConnected) return origin
  const key = origin?.dataset?.key
  const row = key ? document.querySelector(`.cx-row[data-key="${CSS.escape(key)}"], .cx-home-row[data-key="${CSS.escape(key)}"]`) : null
  return row instanceof HTMLElement && row.getClientRects().length > 0 ? row : homeFocus()
}

/** Where focus rests when nothing else claims it: the map, or in the Conversation view the first session that needs you (else the centre). */
export function homeFocus() {
  if (state.view !== 'conversation') return $('cx-stage')
  return $('cx-convo').querySelector('.cx-home-row') ?? $('cx-convo')
}

export const isShown = node => node instanceof HTMLElement && node.isConnected && node.getClientRects().length > 0

export async function runUndo() {
  const undo = toastState.undo
  if (!undo) return false
  closeToast()
  await undo()
  return true
}
