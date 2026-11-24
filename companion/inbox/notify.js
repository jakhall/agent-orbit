import { statusOf } from '/shared/popout.js'
import { $, el, post, remember, state, stored } from './page-state.js'
import { select } from './panel.js'

const BANNER_MS = 8_000
let bannerTimer = 0
/** @type {Map<string, { kind: string, close: () => void }>} */
const shown = new Map()
let audio = null

/** Whether this window plays the chime when a session needs you (per window, on by default). */
export const isSoundOn = () => stored('notifySound', true) === true

export function setSound(isOn) {
  remember('notifySound', isOn)
  if (isOn) playChime()
}

/** `granted`, `denied`, `default`, or `unsupported` when the window has no notifications. */
export const permission = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)

export async function askPermission() {
  if (permission() !== 'default') return permission()
  try {
    return await Notification.requestPermission()
  } catch {
    return permission()
  }
}

/** Creates the audio context on the first gesture, so the chime may play later while the window is in the background. */
export function bindSound() {
  const unlock = () => {
    try {
      audio ??= new AudioContext()
      if (audio.state === 'suspended') void audio.resume()
    } catch {}
  }
  document.addEventListener('pointerdown', unlock, { capture: true, passive: true })
  document.addEventListener('keydown', unlock, { capture: true })
}

/** A soft rising two-note chime, about a third of a second. */
export function playChime() {
  if (!audio || audio.state !== 'running') return
  const start = audio.currentTime + 0.02
  const out = audio.createGain()
  out.gain.value = 0.5
  out.connect(audio.destination)
  for (const [i, freq] of [659.25, 987.77].entries()) {
    const at = start + i * 0.11
    for (const [partial, level] of [[1, 0.16], [2, 0.025]]) {
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq * partial
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(level, at + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.24)
      osc.connect(gain).connect(out)
      osc.start(at)
      osc.stop(at + 0.26)
    }
  }
}

const isLooking = () => !document.hidden && document.hasFocus()

function openSession(key) {
  window.focus()
  closeBanner()
  if (state.snapshot?.sessions?.some(s => s.key === key)) select(key)
}

/** Shows a notice the server pushed to this window: a banner while someone is looking, else a Windows notification when allowed, else the banner. */
export async function onNotice(notice) {
  if (!notice || typeof notice.id !== 'string' || !state.windowId) return
  const windowId = state.windowId
  let claim = null
  try {
    claim = await post(`/api/notices/${notice.id}/claim`, { windowId })
  } catch {
    return
  }
  if (claim?.ok !== true) return
  let shownAs = 'banner'
  if (!notice.isQuiet && !isLooking() && permission() === 'granted') {
    try {
      const toast = new Notification(notice.sessionTitle || 'Orbit', { body: [notice.label, notice.body].filter(Boolean).join(' · '), tag: `orbit-${notice.sessionKey}`, silent: true })
      shown.set(`system:${notice.sessionKey}`, { kind: notice.kind, close: () => toast.close() })
      toast.onclick = () => {
        toast.close()
        openSession(notice.sessionKey)
      }
      shownAs = 'system'
    } catch {}
  }
  if (shownAs === 'banner') showBanner(notice)
  if (notice.kind === 'needs-you' && isSoundOn()) playChime()
  void post(`/api/notices/${notice.id}/ack`, { windowId, shownAs }).catch(() => undefined)
}

function showBanner(notice) {
  const box = $('cx-notice')
  clearTimeout(bannerTimer)
  box.dataset.kind = notice.kind
  for (const key of [...shown.keys()]) if (key.startsWith('banner:')) shown.delete(key)
  shown.set(`banner:${notice.sessionKey}`, { kind: notice.kind, close: closeBanner })
  box.replaceChildren(
    el('span', { class: `dot b-${notice.kind}`, 'aria-hidden': 'true' }),
    el(
      'span',
      { class: 'cx-notice-text' },
      el('span', { class: 'cx-notice-label' }, notice.label),
      el('span', { class: 'cx-notice-title' }, notice.sessionTitle),
      notice.body ? el('span', { class: 'cx-notice-body' }, notice.body) : null,
    ),
    el('button', { class: 'small', onclick: () => openSession(notice.sessionKey) }, 'Open'),
    el('button', { class: 'cx-notice-close', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: closeBanner }, '×'),
  )
  box.hidden = false
  box.classList.remove('is-in')
  void box.offsetWidth
  box.classList.add('is-in')
  armBanner()
}

function armBanner() {
  clearTimeout(bannerTimer)
  bannerTimer = setTimeout(() => {
    const box = $('cx-notice')
    if (box.matches(':hover') || box.contains(document.activeElement) || !isLooking()) return armBanner()
    closeBanner()
  }, BANNER_MS)
}

/**
 * Takes down the banner and any Windows notification about a session that has
 * since left the state they announced, so a finished session never still says it needs you.
 */
export function dropStaleNotices() {
  if (shown.size === 0 || !state.snapshot) return
  for (const [id, entry] of [...shown]) {
    const key = id.slice(id.indexOf(':') + 1)
    const s = state.snapshot.sessions?.find(x => x.key === key)
    if (s && statusOf(s).bucket === entry.kind) continue
    shown.delete(id)
    entry.close()
  }
}

export function closeBanner() {
  const box = $('cx-notice')
  clearTimeout(bannerTimer)
  if (box.contains(document.activeElement)) $('cx-stage').focus({ preventScroll: true })
  box.hidden = true
  for (const key of [...shown.keys()]) if (key.startsWith('banner:')) shown.delete(key)
}
