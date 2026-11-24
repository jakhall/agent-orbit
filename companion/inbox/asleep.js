// @ts-check

import { asleepCardText, canWake, WAKE_HOLD_MS } from '/shared/popout.js'
import { el, hooks } from './ctx.js'

/** @type {Map<string, { at: number, error: string | null }>} each session's last press of the moon, and why opening it failed */
const wakes = new Map()

const SLEEPER = '<svg viewBox="0 0 40 40" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="asleep-moon" d="M27 23.5A10 10 0 1 1 15 11.2a8 8 0 0 0 12 12.3z"/><path class="asleep-z z1" d="M26 6h4l-4 4.5h4"/><path class="asleep-z z2" d="M32.5 12.5h3l-3 3.5h3"/></svg>'

function sleeper() {
  const span = document.createElement('span')
  span.className = 'asleep-art'
  span.setAttribute('aria-hidden', 'true')
  span.innerHTML = SLEEPER
  return span
}

export function barSpinner(extra = '') {
  return el('span', { class: `bar-spinner${extra ? ` ${extra}` : ''}`, 'aria-hidden': 'true' }, ...Array.from({ length: 12 }, () => el('span', {})))
}

async function wake(s) {
  const entry = { at: Date.now(), error: null }
  wakes.set(s.key, entry)
  hooks.rerender()
  setTimeout(() => wakes.get(s.key) === entry && hooks.rerender(), WAKE_HOLD_MS + 100)
  const error = await hooks.wakeSession(s)
  if (!error || wakes.get(s.key) !== entry) return
  entry.error = error
  hooks.rerender()
}

function phaseOf(key) {
  const entry = wakes.get(key)
  if (!entry) return { phase: 'asleep', error: null }
  if (entry.error) return { phase: 'failed', error: entry.error }
  return { phase: Date.now() - entry.at < WAKE_HOLD_MS ? 'waking' : 'stalled', error: null }
}

/**
 * The one-line card above the message box of an asleep desktop session: what
 * happened, and the sleeping moon, a button that opens the session in Claude
 * desktop so it restarts (a spinner while it does). When opening fails, or
 * the session is still asleep after `WAKE_HOLD_MS`, the card says so and the
 * moon tries again. Null for any other session.
 * @param {import('../../types').SessionView} s
 * @returns {HTMLElement | null}
 */
export function asleepCard(s) {
  if (s.canMessage || !canWake(s)) {
    wakes.delete(s.key)
    return null
  }
  const { phase, error } = phaseOf(s.key)
  const isWaking = phase === 'waking'
  const text = asleepCardText(phase, error)
  const button = el('button', {
    type: 'button',
    class: 'wake-moon',
    'data-key': s.key,
    disabled: isWaking,
    'aria-label': text.label,
    title: phase === 'asleep' ? 'Wake up: opens this session in Claude desktop, which restarts it' : text.label,
    onclick: () => void wake(s),
  }, isWaking ? barSpinner() : sleeper())
  const isProblem = phase === 'stalled' || phase === 'failed'
  return el('div', { class: `asleep-card${isWaking ? ' waking' : ''}${isProblem ? ' trouble' : ''}`, role: isProblem ? 'alert' : 'status' },
    el('p', { class: 'asleep-words', title: `${text.title}: ${text.line}` }, el('strong', {}, text.title), el('span', {}, text.line)),
    button)
}
