import { ago, shortModel, truncate } from '/shared/format.js'
import { chatMarks } from '/shared/popout.js'
import { icon } from './icons.js'
import { messageRow } from './chat.js'
import { api, hooks, state as chatState } from './ctx.js'
import { el, state } from './page-state.js'
import { iconButton } from './actions.js'

const POLL_MS = 500
const POLL_FOR_MS = 20_000
const AT_END_PX = 24
export const LIFECYCLE_BUCKET = { running: 'working', failed: 'failed', completed: 'review' }
export const LIFECYCLE_TEXT = { running: 'Running', idle: 'Idle', completed: 'Finished', failed: 'Failed', killed: 'Stopped', cancelled: 'Stopped' }
const STOP_TEXT = {
  stopped: 'Stopped.',
  idle: 'It had already finished.',
  failed: 'Orbit could not stop it. A sub-agent running in the foreground stops only from its session: open the session to stop it.',
  expired: 'The session did not take the stop; it may be closed.',
}

/** The open sub-agent panel's parts, kept across redraws so the message box keeps its text and caret. */
let ap = null

export function agentOf(agentKey) {
  return state.lookup?.agents?.get(agentKey) ?? (state.snapshot?.agents ?? []).find(a => a?.key === agentKey) ?? null
}

/**
 * The panel for one sub-agent: what it is and where it stands, its parent,
 * its transcript (prompt and tool calls, refetched as it works), and, while
 * replies are armed and its session's Orbit can reach it, a message box and
 * Stop.
 * @param {HTMLElement} panel
 * @param {string} agentKey `${sessionKey}/${agentId}`
 * @param {{ select: (key: string) => void, close: () => void }} actions
 */
export function renderAgentPanel(panel, agentKey, actions) {
  const a = agentOf(agentKey)
  const sessionKey = agentKey.slice(0, agentKey.lastIndexOf('/'))
  if (!ap || ap.key !== agentKey || !ap.root.isConnected) {
    ap?.abort?.abort()
    ap = build(agentKey, sessionKey, actions)
    panel.replaceChildren(ap.root)
  } else if (ap.root.parentElement !== panel) panel.replaceChildren(ap.root)
  const s = state.lookup?.sessions.get(sessionKey) ?? null
  const headSig = JSON.stringify([a?.description, a?.name, a?.type, a?.lifecycle, a?.model, a?.startedAt, s?.title])
  if (headSig !== ap.headSig) {
    const hadFocus = ap.head.contains(document.activeElement) ? document.activeElement?.id || document.activeElement?.className : null
    ap.headSig = headSig
    ap.head.replaceChildren(...header(a, s, sessionKey, actions))
    if (hadFocus) (ap.head.querySelector(`#${CSS.escape(String(hadFocus))}`) ?? ap.head.querySelector('h2'))?.focus({ preventScroll: true })
  }
  paintControls(a, s)
  if (!chatState.showConvo) {
    ap.hidden.hidden = false
    ap.list.hidden = true
    return
  }
  ap.hidden.hidden = true
  ap.list.hidden = false
  if (a && a.lastActivityAt !== ap.activityAt && !ap.loading) void load(a)
}

function build(agentKey, sessionKey, actions) {
  const p = { key: agentKey, sessionKey, agentId: agentKey.slice(agentKey.lastIndexOf('/') + 1), headSig: '', activityAt: undefined, loading: false, abort: null, busy: false, controlsSig: '' }
  p.head = el('div', { class: 'cx-slot' })
  p.rows = el('div', { class: 'chat-rows' })
  p.status = el('p', { class: 'cx-note', role: 'status' })
  p.list = el('div', { class: 'chat-list', tabindex: '0', role: 'region', 'aria-label': 'Sub-agent transcript, newest last' }, p.rows, p.status)
  p.hidden = el('p', { class: 'chat-hidden-note note', hidden: true }, 'Conversation text is off in this window.')
  p.area = el('textarea', { rows: 1, maxlength: 4000, 'aria-label': 'Message this sub-agent', placeholder: 'Message this sub-agent', spellcheck: 'true' })
  p.send = el('button', { class: 'primary', type: 'button' }, icon('send'), el('span', {}, 'Send'))
  p.stop = el('button', { type: 'button' }, icon('stop'), el('span', {}, 'Stop'))
  p.note = el('p', { class: 'cx-note', role: 'status' })
  p.why = el('div', { class: 'cx-agent-why' })
  p.area.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void sendMessage()
    }
  })
  p.send.addEventListener('click', () => void sendMessage())
  p.stop.addEventListener('click', () => void stopAgent())
  p.compose = el('div', { class: 'composer' }, el('div', { class: 'send-row' }, p.area, p.send, p.stop), p.why, p.note)
  p.root = el(
    'div',
    { class: 'cx-agent' },
    el('div', { class: 'cx-panel-top' }, p.head),
    el('section', { class: 'chat', 'aria-labelledby': 'agent-chat-title' }, el('div', { class: 'chat-head' }, icon('agents', 'accent'), el('h3', { class: 'h-title', id: 'agent-chat-title' }, 'Transcript')), p.hidden, el('div', { class: 'chat-body' }, p.list), el('div', { class: 'chat-compose' }, p.compose)),
  )
  p.list.addEventListener('scroll', () => (p.atBottom = p.list.scrollHeight - p.list.scrollTop - p.list.clientHeight <= AT_END_PX), { passive: true })
  p.atBottom = true
  p.actions = actions
  return p
}

function header(a, s, sessionKey, actions) {
  const lifecycle = a?.lifecycle ?? 'unknown'
  const bucket = LIFECYCLE_BUCKET[lifecycle] ?? 'idle'
  const title = a ? a.description || a.name || a.type || 'Sub-agent' : 'Sub-agent'
  const fact = (name, value, label, attrs = {}) => el('div', { class: 'cx-fact', title: label }, icon(name), el('span', { class: 'sr-only' }, `${label}: `), el('span', attrs, value))
  return [
    el(
      'header',
      { class: 'cx-panel-head' },
      el(
        'div',
        {},
        el('h2', { id: 'cx-panel-title', tabindex: '-1' }, truncate(title, 120)),
        el(
          'p',
          { class: 'cx-status-line' },
          el('span', { class: `dot b-${bucket}`, 'aria-hidden': 'true' }),
          el('span', {}, a ? (LIFECYCLE_TEXT[lifecycle] ?? 'Unknown') : 'No longer in Orbit'),
          a?.type ? el('span', { class: 'muted' }, `Sub-agent · ${a.type}`) : el('span', { class: 'muted' }, 'Sub-agent'),
        ),
      ),
      iconButton('close', 'Close (Esc)', actions.close, { class: 'ghost cx-close' }),
    ),
    el('div', { class: 'cx-actions' }, el('button', { id: 'cx-agent-parent', type: 'button', onclick: () => actions.select(sessionKey), title: s ? `Open ${s.title}` : 'Open the session it belongs to' }, icon('session'), el('span', {}, `Parent: ${truncate(s?.title ?? 'its session', 48)}`))),
    el(
      'div',
      { class: 'cx-fact-grid' },
      a?.model ? fact('model', shortModel(a.model), `Model · ${a.model}`) : null,
      a?.startedAt ? fact('clock', `started ${ago(Date.now() - a.startedAt)} ago`, 'Started', { class: 'age' }) : null,
      a?.lastActivityAt ? fact('activity', `active ${ago(Date.now() - a.lastActivityAt)} ago`, 'Last activity', { class: 'age' }) : null,
    ),
  ]
}

/** Whether the message box and Stop work, and why not: replies must be armed and the session's Orbit must reach its sub-agents. */
function reach(a, s) {
  if (!a) return { ok: false, why: 'This sub-agent is no longer in Orbit.' }
  if (!s?.cliSessionId) return { ok: false, why: 'Its session has no Claude Code id, so Orbit cannot reach it.' }
  if (s.publisher?.agentProtocol !== 1) return { ok: false, why: 'Its session runs an older Orbit, which cannot reach sub-agents; open the session instead.', open: true }
  if (!hooks.isArmed?.('replies')) return { ok: false, why: 'Replies as me are off, so Orbit cannot message or stop sub-agents.', arm: true }
  return { ok: true, why: '' }
}

function paintControls(a, s) {
  const r = reach(a, s)
  const sig = JSON.stringify([r.ok, r.why, a?.lifecycle, ap.busy])
  if (sig === ap.controlsSig) return
  ap.controlsSig = sig
  ap.area.disabled = !r.ok
  ap.send.disabled = !r.ok || ap.busy
  ap.stop.disabled = !r.ok || ap.busy || a?.lifecycle !== 'running'
  ap.stop.title = a?.lifecycle === 'running' ? 'Stop this sub-agent' : 'It is not running'
  ap.why.replaceChildren(
    ...(r.ok
      ? []
      : [
          el('p', { class: 'cx-note' }, r.why),
          r.arm && hooks.showSwitches ? el('button', { class: 'small', type: 'button', onclick: () => hooks.showSwitches() }, 'Turn on replies') : null,
          r.open && s && hooks.openSession ? el('button', { class: 'small', type: 'button', onclick: () => hooks.openSession(s) }, 'Open session') : null,
        ].filter(Boolean)),
  )
}

async function load(a) {
  const p = ap
  p.loading = true
  p.abort = new AbortController()
  const activityAt = a.lastActivityAt
  try {
    const data = await api('GET', `/api/conversation?key=${encodeURIComponent(p.sessionKey)}&agent=${encodeURIComponent(p.agentId)}`, undefined, p.abort.signal)
    if (ap !== p) return
    p.activityAt = activityAt
    paintRows(Array.isArray(data.rows) ? data.rows : [], data.isStart === true)
  } catch (error) {
    if (ap !== p || p.abort.signal.aborted) return
    p.activityAt = activityAt
    p.rows.replaceChildren()
    p.status.textContent = error.status === 404 ? error.message : 'Couldn’t load the transcript.'
  } finally {
    p.loading = false
  }
  const latest = agentOf(p.key)
  if (ap === p && latest && latest.lastActivityAt !== p.activityAt) void load(latest)
}

function paintRows(rows, isStart) {
  const p = ap
  const wasAtBottom = p.atBottom
  const marks = chatMarks(rows, Date.now())
  p.rows.replaceChildren(...rows.flatMap((r, i) => {
    const mark = marks[i] ?? { day: null, head: true, turn: true }
    return mark.day ? [el('div', { class: 'chat-day', role: 'separator' }, mark.day), messageRow(p.key, r, mark)] : [messageRow(p.key, r, mark)]
  }))
  p.status.textContent = rows.length === 0 ? 'Nothing in its transcript yet.' : isStart ? '' : 'Older messages are in the session.'
  requestAnimationFrame(() => {
    if (ap !== p) return
    for (const node of p.rows.children) {
      const body = node.querySelector('.msg-text.clamped')
      const toggle = node.querySelector('.more-btn')
      if (!body || !toggle) continue
      toggle.hidden = body.scrollHeight <= body.clientHeight + 1
      body.classList.toggle('overflows', !toggle.hidden)
    }
    if (wasAtBottom) p.list.scrollTop = p.list.scrollHeight
  })
}

async function poll(route) {
  const until = Date.now() + POLL_FOR_MS
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, POLL_MS))
    const answer = await api('GET', route).catch(error => (error.status === 404 ? { status: 'unknown' } : null))
    if (answer && answer.status !== 'pending' && answer.status !== 'held') return answer
  }
  return { status: 'unknown' }
}

function setBusy(p, busy, note = null) {
  p.busy = busy
  if (note !== null) p.note.textContent = note
  p.controlsSig = ''
  if (ap === p) paintControls(agentOf(p.key), state.lookup?.sessions.get(p.sessionKey) ?? null)
}

async function sendMessage() {
  const p = ap
  const text = p.area.value.trim()
  if (!text || p.busy || p.area.disabled) return
  setBusy(p, true, 'Sending…')
  let id
  try {
    id = (await api('POST', '/api/reply', { sessionKey: p.sessionKey, text, agentId: p.agentId })).id
  } catch (error) {
    setBusy(p, false, error.message || 'Couldn’t send it.')
    return
  }
  p.area.value = ''
  const answer = await poll(`/api/reply/${id}`)
  setBusy(p, false, answer.status === 'sent' || answer.status === 'queued' ? 'Sent to the sub-agent.' : answer.status === 'unknown' ? 'No answer from the session yet; check the transcript.' : 'The sub-agent did not take it.')
  if (answer.status !== 'sent' && answer.status !== 'queued' && answer.status !== 'unknown' && ap === p && !p.area.value) p.area.value = text
}

async function stopAgent() {
  const p = ap
  if (p.busy || p.stop.disabled) return
  setBusy(p, true, 'Stopping…')
  let id
  try {
    id = (await api('POST', '/api/stop', { sessionKey: p.sessionKey, agentId: p.agentId })).id
  } catch (error) {
    setBusy(p, false, error.message || 'Couldn’t ask it to stop.')
    return
  }
  const answer = await poll(`/api/stop/${id}`)
  setBusy(p, false, STOP_TEXT[answer.status] ?? 'No answer from the session yet; check the session.')
}

export function closeAgentPanel() {
  ap?.abort?.abort()
  ap = null
}
