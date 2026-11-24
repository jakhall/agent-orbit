import { REMOTE_SWITCH_WAIT_MS, remoteSwitchState } from '/shared/popout.js'
import { api, el, hooks } from './ctx.js'
import { iconButton } from './actions.js'
import { commandsFor } from './composer.js'

const pending = new Map()

function stateFor(s) {
  const list = commandsFor(s.key)
  const listed = list?.known ? list.commands.some(c => c.name === 'remote-control') : null
  const press = pending.get(s.key) ?? null
  const st = remoteSwitchState(s, { armed: hooks.isArmed('replies'), listed, pending: press, now: Date.now() })
  if (press && st.settled && !st.note) pending.delete(s.key)
  return st
}

/** What the switch shows for `s`, so the panel redraws it only when that changes. */
export function remoteSwitchSignature(s) {
  const st = stateFor(s)
  return JSON.stringify([s.key, st.on, st.disabled, st.reason, st.note])
}

/** The panel's Remote Control toggle, an icon button in the actions row (filled while on): asks the session to run /remote-control, then waits for its desktop record to flip. */
export function remoteSwitch(s) {
  const st = stateFor(s)
  const button = iconButton('remote-control', `Remote Control is ${st.on ? 'on' : 'off'}`, () => void press(s, st), {
    class: 'cx-remote-btn',
    'aria-pressed': st.on ? 'true' : 'false',
    'aria-disabled': st.disabled ? 'true' : 'false',
    'aria-describedby': 'cx-remote-note',
    title: st.reason ?? (st.on ? 'Remote Control is on. Turn it off: runs /remote-control in the session.' : 'Remote Control is off. Turn it on: runs /remote-control in the session.'),
  })
  return el(
    'span',
    { class: 'cx-remote' },
    button,
    el('span', { id: 'cx-remote-note' }, el('span', { class: 'note', role: 'status' }, st.note ?? ''), st.reason ? el('span', { class: 'sr-only' }, st.reason) : null),
  )
}

async function press(s, st) {
  if (st.disabled) return
  pending.set(s.key, { from: st.on, at: Date.now() })
  hooks.rerender()
  try {
    await api('POST', '/api/reply', { sessionKey: s.key, text: '/remote-control', toggle: 'remote-control' })
  } catch (error) {
    pending.delete(s.key)
    hooks.status(`Remote Control: ${error.message}`, true)
    hooks.rerender()
    return
  }
  setTimeout(() => hooks.rerender(), REMOTE_SWITCH_WAIT_MS + 500)
}
