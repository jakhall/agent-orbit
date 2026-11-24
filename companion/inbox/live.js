import { DEFAULT_FILTERS, DEFAULT_SETTINGS } from '/shared/constants.js'
import { normalizeSnapshot, packedProjects, visibleOf } from '/shared/filters.js'
import { alertText, armedCapabilities, attentionPost, layoutKeyOf, paintedStats, settingsName, snapshotChanged, withLayout } from '/shared/popout.js'
import { sanitizePrefs } from '/shared/prefs.js'
import { lookupOf } from '/shared/render.js'
import { shouldRefit } from '/shared/camera.js'
import { endedApprovals, isAttentive } from '/shared/approvals.js'
import { state as chatState } from './ctx.js'
import { followConversation } from './chat.js'
import { noteLaunches, refreshSettings } from './sheets.js'
import { $, api, applyPhase, el, post, state, stored } from './page-state.js'
import { renderAll, renderHeader } from './header.js'
import { homeFocus } from './toast.js'
import { animateTo, fitTarget, framedNodes } from './stage.js'
import { recoverFocus } from './keys.js'
import { renderPanel } from './panel.js'
import { dropStaleNotices, onNotice } from './notify.js'

let isLoading = false
let isLoadDirty = false
export async function load() {
  if (isLoading) {
    isLoadDirty = true
    return
  }
  isLoading = true
  try {
    const data = await api('/api/state?v=2')
    state.everAnswered = true
    state.loadFailures = 0
    state.prefs = sanitizePrefs(data.prefs)
    state.stamps = data.stamps
    state.checkedAt = data.stamps?.checkedAt ?? state.checkedAt
    const applyStart = performance.now()
    const isSchema2 = Boolean(data.snapshot && data.snapshot.schema === 2 && Array.isArray(data.snapshot.sessions))
    if (isSchema2) {
      state.loadError = null
      const pack = packedProjects(data.snapshot, { ...DEFAULT_FILTERS, ...state.prefs.filters }, Date.now(), state.prefs.pinned ?? [])
      const layoutKey = layoutKeyOf(data.snapshot, state.prefs.positions ?? {}, pack)
      if (layoutKey !== state.layoutKey || !state.snapshot) {
        state.snapshot = withLayout(normalizeSnapshot(data.snapshot), state.prefs.positions ?? {}, { pack })
        state.lookup = lookupOf(state.snapshot)
        state.layoutKey = layoutKey
      }
      applyPhase('layout', applyStart)
      state.acceptedAt = Date.now()
      const filters = { ...DEFAULT_FILTERS, ...state.prefs.filters }
      const settings = { ...DEFAULT_SETTINGS, ...state.prefs.settings }
      const visibleStart = performance.now()
      state.visible = visibleOf(state.snapshot, filters, settings, state.prefs.collapsed ?? [], Date.now(), { pinned: state.prefs.pinned ?? [], hidden: state.prefs.hidden ?? {}, keepNeedsYouInProject: true })
      applyPhase('visible', visibleStart)
      const filterSig = JSON.stringify([filters, state.prefs.collapsed ?? [], state.prefs.hidden ?? {}])
      if (shouldRefit(state.filterSig, filterSig, state.isMoved)) state.pendingFit = true
      state.filterSig = filterSig
    } else if (data.snapshot) {
      state.loadError = 'This Orbit server sends an older snapshot format. Restart Orbit to update it.'
    }
    const startedAt = performance.now()
    renderAll()
    dropStaleNotices()
    if (!state.hasFocusedMap && state.snapshot) {
      state.hasFocusedMap = true
      if (document.activeElement === document.body) homeFocus().focus({ preventScroll: true })
    }
    recoverFocus()
    const extrasStart = performance.now()
    noteLaunches()
    refreshSettings()
    applyPhase('extras', extrasStart)
    noteRender(performance.now() - startedAt)
    if (state.pendingFit && state.view !== 'conversation' && framedNodes().length > 0) {
      state.pendingFit = false
      animateTo(fitTarget())
    }
    if (isSchema2) state.lastApplyMs = performance.now() - applyStart
    document.body.dataset.seq = String(data.stamps?.seq ?? '')
    document.body.dataset.appliedAt = String(Date.now())
    if (isSchema2) {
      cancelAnimationFrame(paintFrame)
      paintFrame = requestAnimationFrame(() => reportPainted(data.stamps))
    }
  } catch (error) {
    state.loadFailures += 1
    if (!state.snapshot) state.loadError = error.status ? `Couldn’t load sessions: Orbit answered ${error.status}.` : 'Orbit isn’t answering. Is it still running?'
    renderAll()
  } finally {
    isLoading = false
    if (isLoadDirty) {
      isLoadDirty = false
      void load()
    }
  }
}

let paintFrame = 0
const renderStats = { count: 0, totalMs: 0, maxMs: 0 }
function noteRender(ms) {
  renderStats.count += 1
  renderStats.totalMs += ms
  renderStats.maxMs = Math.max(renderStats.maxMs, ms)
}

function reportPainted(stamps) {
  const painted = paintedStats(stamps, Date.now())
  if (!painted) return
  const body = { renders: renderStats.count, avgMs: renderStats.totalMs / renderStats.count, maxMs: renderStats.maxMs, ...painted }
  fetch('/api/stats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined)
}

let source = null
export function connect() {
  source?.close()
  source = new EventSource('/api/events')
  const onStamps = event => {
    let stamps = null
    try {
      stamps = JSON.parse(event.data)
    } catch {
      return
    }
    state.checkedAt = stamps.checkedAt ?? state.checkedAt
    if (stamps.approvals !== state.approvalsStamp) {
      state.approvalsStamp = stamps.approvals
      void loadApprovals()
    }
    if (stamps.arm !== state.armStamp) {
      state.armStamp = stamps.arm
      void loadArm()
    }
    if (stamps.alerts !== state.alertStamp) {
      state.alertStamp = stamps.alerts
      void loadAlerts()
    }
    if (snapshotChanged(state.stamps, stamps) || stamps.prefs !== state.stamps?.prefs) void load()
    else renderHeader()
  }
  source.addEventListener('hello', event => {
    state.overrideErrors.clear()
    state.connected = true
    state.droppedAt = null
    state.isClosed = false
    state.approvalsStamp = undefined
    try {
      const hello = JSON.parse(event.data)
      state.windowId = typeof hello.windowId === 'string' ? hello.windowId : null
    } catch {}
    onStamps(event)
    reportAttention()
  })
  source.addEventListener('conversation', event => {
    try {
      const { key } = JSON.parse(event.data)
      if (typeof key === 'string') followConversation(key)
    } catch {}
  })
  source.addEventListener('changed', onStamps)
  source.addEventListener('notice', event => {
    try {
      void onNotice(JSON.parse(event.data))
    } catch {}
  })
  source.onerror = () => {
    state.connected = false
    state.droppedAt ??= Date.now()
    if (source.readyState === EventSource.CLOSED) state.isClosed = true
    renderHeader()
  }
}

export function retry() {
  state.loadError = null
  renderAll()
  homeFocus().focus({ preventScroll: true })
  connect()
  void load()
}

export async function loadArm() {
  try {
    state.arm = await api('/api/arm')
  } catch {
    return
  }
  renderArmed()
  refreshSettings()
}

async function loadApprovals() {
  let answer = null
  try {
    answer = await api('/api/approvals')
  } catch {
    return
  }
  if (!Array.isArray(answer?.approvals)) return
  for (const ended of endedApprovals(chatState.approvals, answer.approvals, chatState.approvalOutcomes, Date.now())) chatState.approvalOutcomes.set(ended.id, ended)
  while (chatState.approvalOutcomes.size > 200) chatState.approvalOutcomes.delete(chatState.approvalOutcomes.keys().next().value)
  chatState.approvals = answer.approvals
  chatState.approvalsEnabled = answer.enabled === true
  renderPanel()
}

let lastAttention = null
/** Tells the server whether someone is looking at this window and which session is open, so it routes requests and transcript updates here. */
export function reportAttention() {
  const focused = document.hasFocus()
  const attentive = !document.hidden && isAttentive(focused, state.lastInputAt, Date.now())
  const body = attentionPost(attentive, state.windowId, lastAttention, state.convo.key, focused)
  if (!body) return
  lastAttention = body
  void post('/api/attention', body).catch(() => undefined)
}

export function isArmed(capability) {
  return state.arm?.[capability]?.armed === true
}

async function loadAlerts() {
  try {
    const answer = await api('/api/alerts')
    state.alerts = Array.isArray(answer.alerts) ? answer.alerts : []
  } catch {
    return
  }
  renderAlert()
}

function renderAlert() {
  const box = $('cx-alert')
  const seenAt = stored('alertSeenAt', 0)
  const latest = state.alerts.find(a => a.at > seenAt) ?? null
  box.hidden = latest === null
  if (!latest) return box.replaceChildren()
  box.replaceChildren(
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    el('span', {}, alertText(latest)),
    el('button', { onclick: () => {
      try {
        localStorage.setItem('orbit.alertSeenAt', JSON.stringify(latest.at))
      } catch {}
      renderAlert()
      homeFocus().focus({ preventScroll: true })
    } }, 'Dismiss'),
  )
}

function renderArmed() {
  const armed = capability => state.arm?.[capability]?.armed === true
  const chips = armedCapabilities({ approvals: armed('approvals'), questions: armed('questions'), replies: armed('replies') })
  const button = $('cx-settings-open')
  const name = settingsName(chips)
  button.setAttribute('aria-label', name)
  button.title = name
  button.classList.toggle('is-armed', chips.length > 0)
  button.dataset.armedFocus = chips.length ? `cx-s-arm-${chips[0].key}` : ''
}

export async function pollHealth() {
  try {
    state.health = await api('/api/health')
  } catch {
    state.health = null
  }
  renderHeader()
}
