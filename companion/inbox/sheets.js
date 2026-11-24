import { DEFAULT_FILTERS, DEFAULT_SETTINGS, TIME_PRESETS } from '/shared/constants.js'
import { isHiddenNow } from '/shared/filters.js'
import { clockTime, duration, plural, truncate } from '/shared/format.js'
import { desktopOutcome, LAUNCH_EFFORTS, LAUNCH_MODELS, LAUNCH_MODES, launchFormState, launchStatus, mayAutoSelect, promptStateText } from '/shared/launch.js'
import { handOffLink, recentFolders } from '/shared/links.js'
import { armSetupLine, auditText, draftOf, isNoWindow, modelOptions, NO_WINDOW_TEXT, paletteResults, switcherResults, switcherRowMeta, switcherStatus } from '/shared/popout.js'
import { $, api, el, state as chat } from './ctx.js'
import { icon } from './icons.js'
import { askPermission, isSoundOn, permission, setSound } from './notify.js'

/**
 * The page's dialogs: Settings (a sheet at the right), New session (a modal)
 * and the Ctrl+K palette. Each is a native <dialog>, so focus stays inside,
 * Esc closes it, and the page behind cannot be reached until it closes.
 */

let page = null

const ARM_NAME = { approvals: 'Approvals', questions: 'Questions', replies: 'Replies as me' }
const ARM_NOTE = {
  approvals: 'While you use an Orbit window, permission prompts wait here first (60 s), then go to Claude.',
  questions: 'Questions from sessions wait here first; Answer in Claude sends one back.',
  replies: 'Orbit can send messages into sessions as your own words.',
}
const NOTIFY_OPTIONS = [
  { value: 'all', label: 'Needs you, failed and ready for review' },
  { value: 'needs-you', label: 'Only when a session needs you' },
  { value: 'off', label: 'Off' },
]
const AGENT_OPTIONS = [0, 4, 8, 16, 32].map(n => ({ value: String(n), label: n === 0 ? 'None' : String(n) }))
const MAX_OPTIONS = [25, 50, 100, 200, 300].map(n => ({ value: String(n), label: String(n) }))
const STALE_OPTIONS = [5, 10, 20, 30, 60].map(n => ({ value: String(n), label: `${n} min` }))
const ANIMATION_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
]
const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const stored = (key, fallback) => {
  try {
    const raw = localStorage.getItem(`orbit.${key}`)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}
const remember = (key, value) => {
  try {
    localStorage.setItem(`orbit.${key}`, JSON.stringify(value))
  } catch {}
}

function select(id, options, value, attrs = {}) {
  return el('select', { id, ...attrs }, ...options.map(o => el('option', { value: o.value, selected: o.value === value || null }, o.label)))
}

function fill(node, options, value) {
  node.replaceChildren(...options.map(o => el('option', { value: o.value, selected: o.value === value || null }, o.label)))
}

function check(id, label, attrs = {}) {
  const input = el('input', { id, type: 'checkbox', ...attrs })
  return { input, row: el('label', { class: 'cx-check' }, input, el('span', {}, label)) }
}

function dialogHead(titleId, title, dialog) {
  return el(
    'header',
    { class: 'cx-dialog-head' },
    el('div', { class: 'cx-dialog-titles' }, el('h2', { id: titleId }, title), el('p', { class: 'cx-dialog-status', role: 'status' })),
    el('button', { class: 'cx-close icon-btn ghost', 'aria-label': `Close ${title}`, title: 'Close (Esc)', onclick: () => dialog.close() }, icon('close')),
  )
}

/** Opens `dialog` as a modal and gives focus back to whatever had it when the dialog closes (else to `fallback`). */
function openDialog(dialog, focus, fallback = 'cx-stage') {
  if (dialog.open) return focus?.focus()
  const back = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  const home = () => (fallback === 'cx-stage' && $('cx-stage')?.hidden ? $('cx-convo') : $(fallback))
  dialog.addEventListener('close', () => (back?.isConnected && back.getClientRects().length > 0 ? back : home())?.focus({ preventScroll: true }), { once: true })
  const status = dialog.querySelector('.cx-dialog-status')
  if (status) status.textContent = ''
  dialog.showModal()
  focus?.focus()
}

/**
 * Feedback for something done inside a dialog: said in that dialog's own
 * status line, since the page's toast sits under the modal and is out of
 * reach there; the page's toast otherwise.
 */
function say(text, action = null) {
  const status = document.querySelector('dialog[open] .cx-dialog-status')
  if (!status) return page.toast(text, action)
  status.textContent = ''
  setTimeout(() => (status.textContent = text), 50)
}

export function isDialogOpen() {
  return Boolean(document.querySelector('dialog[open]'))
}

// Settings ----------------------------------------------------------------

const settingsParts = {}

function buildSettings() {
  const dialog = $('cx-settings')
  const theme = select('cx-s-theme', THEME_OPTIONS, 'system')
  theme.addEventListener('change', () => {
    const value = theme.value
    remember('theme', value)
    if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value
    else delete document.documentElement.dataset.theme
  })
  const convo = check('cx-s-convo', 'Conversation text', { 'aria-describedby': 'cx-s-convo-note' })
  convo.input.addEventListener('change', () => {
    remember('showConvo', convo.input.checked)
    page.rerender()
  })
  const arms = Object.keys(ARM_NAME).map(capability => {
    const box = check(`cx-s-arm-${capability}`, ARM_NAME[capability], { 'aria-describedby': `cx-s-arm-${capability}-note cx-s-arm-${capability}-setup` })
    box.input.addEventListener('change', () => void setArm(capability, box.input.checked))
    const setup = el('span', { class: 'cx-hint cx-setup', id: `cx-s-arm-${capability}-setup` })
    const error = el('span', { class: 'err cx-arm-error', id: `cx-s-arm-${capability}-error`, hidden: true })
    box.input.setAttribute('aria-describedby', `cx-s-arm-${capability}-note cx-s-arm-${capability}-setup cx-s-arm-${capability}-error`)
    return { capability, ...box, setup, error, block: el('div', { class: 'cx-arm' }, box.row, el('span', { class: 'cx-hint', id: `cx-s-arm-${capability}-note` }, ARM_NOTE[capability]), setup, error) }
  })
  const notify = select('cx-s-notify', NOTIFY_OPTIONS, 'needs-you', { 'aria-describedby': 'cx-s-notify-note' })
  notify.addEventListener('change', () => void setNotify(notify.value))
  const sound = check('cx-s-sound', 'Play a chime when a session needs you')
  sound.input.addEventListener('change', () => {
    setSound(sound.input.checked)
    say(sound.input.checked ? 'Chime on in this window.' : 'Chime off in this window.')
  })
  const permissionText = el('span', { class: 'cx-hint', id: 'cx-s-perm' })
  const allow = el('button', { class: 'small', 'aria-describedby': 'cx-s-perm', onclick: () => void askPermission().then(answer => (syncPermission(), say(answer === 'granted' ? 'Windows notifications allowed.' : 'Windows notifications not allowed; banners still show here.'))) }, 'Allow Windows notifications')
  const time = select('cx-s-time', TIME_PRESETS.map(p => ({ value: p.value, label: p.label })), DEFAULT_FILTERS.time)
  time.addEventListener('change', () => void page.patchPrefs({ filters: { time: time.value } }))
  const project = el('select', { id: 'cx-s-project', 'aria-describedby': 'cx-s-project-note' })
  project.addEventListener('change', () => void page.patchPrefs({ filters: { project: project.value } }))
  const prNeeds = check('cx-s-pr-needs', 'Failing PRs need you', { 'aria-describedby': 'cx-s-pr-needs-note' })
  prNeeds.input.addEventListener('change', () => void page.patchPrefs({ settings: { prProblemsNeedYou: prNeeds.input.checked } }).then(saved => saved && say(prNeeds.input.checked ? 'Failing PRs now need you.' : 'PRs no longer make a session need you.')))
  const completed = check('cx-s-completed', 'Finished sessions')
  completed.input.addEventListener('change', () => void page.patchPrefs({ filters: { showCompleted: completed.input.checked } }))
  const stale = check('cx-s-stale', 'Stale sessions (stopped reporting)')
  stale.input.addEventListener('change', () => void page.patchPrefs({ filters: { showStale: stale.input.checked } }))
  const agents = select('cx-s-agents', AGENT_OPTIONS, String(DEFAULT_SETTINGS.maxSubagents))
  agents.addEventListener('change', () => void page.patchPrefs({ settings: { maxSubagents: Number(agents.value) } }))
  const max = select('cx-s-max', MAX_OPTIONS, String(DEFAULT_SETTINGS.maxSessions))
  max.addEventListener('change', () => void page.patchPrefs({ settings: { maxSessions: Number(max.value) } }))
  const staleAfter = select('cx-s-stale-after', STALE_OPTIONS, String(DEFAULT_SETTINGS.staleMinutes))
  staleAfter.addEventListener('change', () => void page.patchPrefs({ settings: { staleMinutes: Number(staleAfter.value) } }))
  const animation = select('cx-s-anim', ANIMATION_OPTIONS, DEFAULT_SETTINGS.animation, { 'aria-describedby': 'cx-s-anim-note' })
  animation.addEventListener('change', () => void page.patchPrefs({ settings: { animation: animation.value } }))
  const paused = check('cx-s-paused', 'Pause live updates')
  paused.input.addEventListener('change', () => void page.patchPrefs({ settings: { paused: paused.input.checked } }))
  const resetLayout = el('button', { class: 'small', onclick: () => void page.patchPrefs({ resetLayout: true }).then(saved => saved && say('Map layout reset.')) }, 'Reset map layout')
  const clear = el('button', { class: 'small', 'aria-describedby': 'cx-s-clear-note', onclick: () => void clearData() }, 'Clear data…')
  const usage = el('ul', { id: 'cx-s-usage', class: 'cx-usage', tabindex: '-1', 'aria-label': 'Usage limits' })
  const diagnostics = el('div', { id: 'cx-s-diag' })
  const diagBox = el('details', { class: 'cx-diag' }, el('summary', {}, 'Diagnostics'), diagnostics)
  diagBox.addEventListener('toggle', () => diagBox.open && void loadDiagnostics())
  dialog.replaceChildren(
    dialogHead('cx-settings-title', 'Settings', dialog),
    el(
      'div',
      { class: 'cx-dialog-body' },
      el(
        'section',
        { 'aria-labelledby': 'cx-s-window' },
        el('h3', { id: 'cx-s-window' }, icon('session', 'accent'), el('span', { class: 'h-title' }, 'This computer’s Orbit windows')),
        el('label', { class: 'cx-field' }, el('span', {}, 'Theme'), theme),
        convo.row,
        el('span', { class: 'cx-hint', id: 'cx-s-convo-note' }, 'Prompt and reply text in the conversation. Turn off when sharing your screen.'),
        sound.row,
        el('div', { class: 'cx-row-actions' }, allow),
        permissionText,
      ),
      el(
        'section',
        { 'aria-labelledby': 'cx-s-all' },
        el('h3', { id: 'cx-s-all' }, icon('remote', 'accent'), el('span', { class: 'h-title' }, 'Orbit windows and the pane')),
        el('fieldset', {}, el('legend', {}, 'Remote control (off by default)'), ...arms.map(a => a.block)),
        el('fieldset', {}, el('legend', {}, 'Usage limits'), usage),
        el('fieldset', {}, el('legend', {}, 'Pull requests'), prNeeds.row, el('span', { class: 'cx-hint', id: 'cx-s-pr-needs-note' }, 'While on, Orbit checks the PRs your sessions link, with gh. When checks fail or changes are requested, the newest session with that PR needs you.')),
        el('label', { class: 'cx-field' }, el('span', {}, 'Notifications'), notify),
        el('span', { class: 'cx-hint', id: 'cx-s-notify-note' }, 'An open Orbit window shows them: a Windows notification while you are elsewhere, a banner while you are looking. With no Orbit window open, a terminal session raises them.'),
        el('label', { class: 'cx-field' }, el('span', {}, 'Map animation'), animation),
        el('span', { class: 'cx-hint', id: 'cx-s-anim-note' }, 'Pulses on the pop-out map: Low sends a sonar ping from sessions that need you, Normal also pulses working ones. Low or Normal animates even when Windows turns animation effects off.'),
        el('fieldset', {}, el('legend', {}, 'Showing'), el('label', { class: 'cx-field' }, el('span', {}, 'Time window'), time), el('label', { class: 'cx-field' }, el('span', {}, 'Project'), project), el('span', { class: 'cx-hint', id: 'cx-s-project-note' }, 'Sessions that need you, and pinned ones, stay listed from every project.'), completed.row, stale.row, el('label', { class: 'cx-field' }, el('span', {}, 'Subagents per session'), agents)),
        el(
          'fieldset',
          {},
          el('legend', {}, 'Data'),
          el('label', { class: 'cx-field' }, el('span', {}, 'Sessions kept'), max),
          el('label', { class: 'cx-field' }, el('span', {}, 'Stale after'), staleAfter),
          paused.row,
          el('div', { class: 'cx-row-actions' }, resetLayout, clear),
          el('span', { class: 'cx-hint', id: 'cx-s-clear-note' }, 'Clear data removes Orbit’s session records, replies, approvals and snapshots, and resets these settings. Your sessions are not touched.'),
        ),
        diagBox,
      ),
    ),
  )
  Object.assign(settingsParts, { project, prNeeds: prNeeds.input, usage, dialog, theme, convo: convo.input, arms, notify, sound: sound.input, allow, permissionText, time, completed: completed.input, stale: stale.input, agents, max, staleAfter, animation, paused: paused.input, resetLayout, diagnostics, diagBox })
}

function syncSettings() {
  const p = settingsParts
  const prefs = page.prefs()
  const f = { ...DEFAULT_FILTERS, ...(prefs?.filters ?? {}) }
  const s = { ...DEFAULT_SETTINGS, ...(prefs?.settings ?? {}) }
  p.theme.value = stored('theme', 'system')
  p.convo.checked = stored('showConvo', true) !== false
  p.sound.checked = isSoundOn()
  syncPermission()
  const arm = page.arm()
  for (const a of p.arms) {
    a.input.checked = arm?.[a.capability]?.armed === true
    const line = arm?.setup ? armSetupLine(a.capability, arm.setup, Date.now()) : null
    if (a.setup.textContent !== (line ?? '')) a.setup.textContent = line ?? ''
  }
  fill(p.time, TIME_PRESETS.map(t => ({ value: t.value, label: t.label })), f.time)
  fill(p.project, [{ value: '', label: 'All projects' }, ...(page.projectOptions() ?? [])], f.project ?? '')
  p.prNeeds.checked = s.prProblemsNeedYou === true
  p.completed.checked = f.showCompleted
  p.stale.checked = f.showStale
  p.agents.value = String(s.maxSubagents)
  p.max.value = String(s.maxSessions)
  p.staleAfter.value = String(s.staleMinutes)
  p.animation.value = s.animation
  p.paused.checked = s.paused === true
  p.resetLayout.hidden = Object.keys(prefs?.positions ?? {}).length === 0
  const limits = page.limits()
  p.usage.replaceChildren(
    ...(limits
      ? limits.parts.map(l => el('li', {}, el('span', { class: `dot is-${l.level}`, 'aria-hidden': 'true' }), `${l.long} limit: ${l.percent}% used${l.resets ? `, resets ${l.resets}` : ''}${limits.asOf ? ` (reading from ${limits.asOf})` : ''}`))
      : [el('li', { class: 'cx-hint' }, 'No usage reading yet.')]),
  )
}

/** Opens Settings, optionally at one control (an armed chip opens it at its switch). */
export function openSettings(focusId = null) {
  syncSettings()
  void loadNotify()
  openDialog(settingsParts.dialog, focusId ? $(focusId) : settingsParts.theme, 'cx-settings-open')
}

/** Keeps an open sheet in step with live arm and prefs changes, never moving focus. */
export function refreshSettings() {
  if (settingsParts.dialog?.open) syncSettings()
  if (newParts.dialog?.open) renderNew()
}

async function setArm(capability, armed) {
  const arm = settingsParts.arms.find(a => a.capability === capability)
  arm.error.hidden = true
  try {
    await api('POST', '/api/arm', { capability, armed })
    say(`${ARM_NAME[capability]} is ${armed ? 'on in every Orbit window' : 'off'}.`)
  } catch (error) {
    arm.error.textContent = isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : `Couldn’t turn ${ARM_NAME[capability]} ${armed ? 'on' : 'off'}. It is still ${armed ? 'off' : 'on'}; try again.`
    arm.error.hidden = false
  }
  await page.reloadArm()
  syncSettings()
}

const PERMISSION_TEXT = {
  granted: 'Windows notifications are allowed for this window.',
  denied: 'Windows notifications are blocked for this window; banners still show here. Allow them again from the window’s site settings.',
  default: 'Windows notifications are not allowed yet; until then a banner shows here.',
  unsupported: 'This window cannot raise Windows notifications; banners still show here.',
}

function syncPermission() {
  const now = permission()
  settingsParts.permissionText.textContent = PERMISSION_TEXT[now] ?? PERMISSION_TEXT.unsupported
  settingsParts.allow.parentElement.hidden = now !== 'default'
}

async function loadNotify() {
  try {
    const answer = await api('GET', '/api/notify')
    if (typeof answer?.mode === 'string') settingsParts.notify.value = answer.mode
  } catch {}
}

async function setNotify(mode) {
  try {
    await api('POST', '/api/notify', { mode })
    say(mode === 'off' ? 'Notifications are off.' : 'Notifications saved.')
  } catch (error) {
    say(isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : 'Couldn’t change notifications. Try again.')
    void loadNotify()
  }
}

async function clearData() {
  if (!confirm('Clear Orbit data? This removes session records, replies, approvals and snapshots, and resets shared settings. Your sessions are not touched.')) return
  try {
    const result = await api('POST', '/api/clear', {})
    say(`Cleared: ${(result.removed ?? []).join(', ') || 'nothing to remove'}.`)
  } catch (error) {
    say(isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : 'Couldn’t clear the data. Try again.')
  }
}

/** An audit entry's time: the clock today, the date and clock before that (newest entries come first). */
function auditWhen(at) {
  const stamp = clockTime(at)
  return stamp.slice(0, 10) === clockTime(Date.now()).slice(0, 10) ? stamp.slice(11) : stamp
}

const ms = value => (Number.isFinite(value) ? `${Math.round(value)} ms` : 'not measured yet')

async function loadDiagnostics() {
  const box = settingsParts.diagnostics
  box.replaceChildren(el('p', { class: 'cx-hint' }, 'Loading…'))
  let health = null
  let audit = null
  try {
    health = await api('GET', '/api/health')
  } catch {}
  try {
    audit = (await api('GET', '/api/audit')).entries ?? null
  } catch {}
  const a = health?.aggregator ?? {}
  const rows = health
    ? [
        ['Server', `Orbit ${health.version} · ${health.daemon ? 'started by a session' : 'started with a window'} · up ${duration(health.uptimeMs)}`],
        ['Aggregator', `${a.isWatching ? 'watching' : 'not watching'}${a.isPaused ? ', paused' : ''} · snapshot ${a.seq} · last run ${a.lastMs} ms`],
        ['Last checked', a.checkedAt ? clockTime(a.checkedAt) : 'never'],
        ['Problems', a.errors?.length ? a.errors.join(', ') : 'none'],
        ['Event to screen', ms(health.latency?.eventToPaintMs)],
        ['Desktop records', health.sources?.desktop ? `${health.sources.desktop.parsed} read, ${health.sources.desktop.failed} failed` : 'unknown'],
        ['Windows', String(health.windows ?? 0)],
      ]
    : [['Server', 'Orbit has not answered the health check.']]
  box.replaceChildren(
    el('dl', { class: 'cx-diag-rows' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
    el('h4', {}, 'Remote-control audit'),
    !Array.isArray(audit)
      ? el('p', { class: 'cx-hint' }, 'Couldn’t load the audit log.')
      : audit.length === 0
        ? el('p', { class: 'cx-hint' }, 'Nothing recorded yet.')
        : el('ol', { class: 'cx-audit' }, ...audit.slice(0, 50).map(e => el('li', {}, el('span', { class: 'cx-muted' }, auditWhen(e.at)), ' ', auditText(e)))),
  )
}

// New session ---------------------------------------------------------------

const newParts = {}
const launchState = { folder: { text: '', info: null, error: null }, timer: 0, seq: 0, isBusy: false, launches: [], pollTimer: 0 }
const FINAL_PROMPT = new Set(['sent', 'queued', 'refused', 'failed', 'dropped'])
const LAUNCH_SHOWN_MS = 5 * 60_000

function buildNew() {
  const dialog = $('cx-new')
  const saved = stored('newChoice', {})
  const folderInput = el('input', { id: 'cx-n-folder', type: 'text', list: 'cx-n-recent', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'cx-n-folder-error cx-n-folder-hint' })
  const recent = el('datalist', { id: 'cx-n-recent' })
  const folderError = el('p', { class: 'err cx-field-error', id: 'cx-n-folder-error', hidden: true })
  const where = select('cx-n-where', [{ value: 'orbit', label: 'Orbit (terminal)' }, { value: 'desktop', label: 'Claude desktop' }], saved.where === 'desktop' ? 'desktop' : 'orbit')
  const model = select('cx-n-model', LAUNCH_MODELS, LAUNCH_MODELS.some(o => o.value === saved.model) ? saved.model : '')
  const effort = select('cx-n-effort', LAUNCH_EFFORTS, LAUNCH_EFFORTS.some(o => o.value === saved.effort) ? saved.effort : '')
  const mode = select('cx-n-mode', LAUNCH_MODES, LAUNCH_MODES.some(o => o.value === saved.mode) && saved.mode !== 'bypassPermissions' ? saved.mode : '')
  const bypass = check('cx-n-bypass', 'I understand: this session will run tools without asking.')
  const prompt = el('textarea', { id: 'cx-n-prompt', rows: 3, maxlength: 4000 })
  const start = el('button', { class: 'primary', id: 'cx-n-start', 'aria-describedby': 'cx-n-status cx-n-folder-error' }, 'Start')
  const status = el('p', { class: 'cx-hint', id: 'cx-n-status', role: 'status' })
  const turnOnReplies = el('button', { class: 'small', type: 'button', id: 'cx-n-arm', hidden: true, onclick: () => openSettings('cx-s-arm-replies') }, 'Turn on replies')
  const orbitOnly = el('div', { class: 'cx-n-options' }, el('label', { class: 'cx-field' }, el('span', {}, 'Model'), model), el('label', { class: 'cx-field' }, el('span', {}, 'Effort'), effort), el('label', { class: 'cx-field' }, el('span', {}, 'Mode'), mode), bypass.row)
  void api('GET', '/api/launch/options')
    .catch(() => null)
    .then(answer => {
      const models = modelOptions(answer, LAUNCH_MODELS)
      const wanted = model.value || saved.model
      fill(model, models, models.some(o => o.value === wanted) ? wanted : '')
    })
  for (const node of [where, model, effort, mode]) {
    node.addEventListener('change', () => {
      if (node === mode) bypass.input.checked = false
      remember('newChoice', { where: where.value, model: model.value, effort: effort.value, mode: mode.value === 'bypassPermissions' ? '' : mode.value })
      renderNew()
    })
  }
  bypass.input.addEventListener('change', renderNew)
  prompt.addEventListener('input', renderNew)
  folderInput.addEventListener('input', () => checkFolder(false))
  folderInput.addEventListener('keydown', event => event.key === 'Enter' && (event.preventDefault(), void startNew()))
  prompt.addEventListener('keydown', event => event.key === 'Enter' && (event.ctrlKey || event.metaKey) && (event.preventDefault(), void startNew()))
  start.addEventListener('click', () => void startNew())
  dialog.replaceChildren(
    dialogHead('cx-new-title', 'New session', dialog),
    el(
      'div',
      { class: 'cx-dialog-body' },
      el('label', { class: 'cx-field cx-wide', for: 'cx-n-folder' }, el('span', {}, 'Folder')),
      el('div', { class: 'cx-n-folder' }, folderInput, recent),
      folderError,
      el('p', { class: 'cx-hint', id: 'cx-n-folder-hint' }, 'Type a path, or pick a recent folder from the list (Alt+Down).'),
      el('label', { class: 'cx-field' }, el('span', {}, 'Where'), where),
      orbitOnly,
      el('label', { class: 'cx-field cx-wide' }, el('span', {}, 'First prompt (optional)'), prompt),
      el('div', { class: 'cx-row-actions' }, start, status, turnOnReplies),
    ),
  )
  Object.assign(newParts, { dialog, folderInput, folderError, recent, where, model, effort, mode, bypass: bypass.input, bypassRow: bypass.row, prompt, start, status, orbitOnly, turnOnReplies })
}

function checkFolder(isNow) {
  const text = newParts.folderInput.value.trim()
  if (!isNow && text === launchState.folder.text) return
  launchState.folder = { text, info: null, error: null }
  renderNew()
  clearTimeout(launchState.timer)
  if (!text) return
  launchState.timer = setTimeout(
    async () => {
      const seq = (launchState.seq += 1)
      try {
        const info = await api('GET', `/api/folder?path=${encodeURIComponent(text)}`)
        if (seq === launchState.seq && launchState.folder.text === text) launchState.folder = { text, info, error: null }
      } catch (error) {
        if (seq === launchState.seq && launchState.folder.text === text) launchState.folder = { text, info: null, error: error.message }
      }
      renderNew()
    },
    isNow ? 0 : 300,
  )
}

function folderState() {
  const f = launchState.folder
  if (!f.text) return 'empty'
  if (f.error) return 'error'
  return f.info ? 'ok' : 'checking'
}

function renderNew() {
  const p = newParts
  const isOrbit = p.where.value === 'orbit'
  p.orbitOnly.hidden = !isOrbit
  const form = launchFormState({ where: isOrbit ? 'orbit' : 'desktop', folderState: folderState(), isLaunchable: launchState.folder.info ? launchState.folder.info.launchable : true, mode: p.mode.value, confirmBypass: p.bypass.checked, isBusy: launchState.isBusy, hasPrompt: p.prompt.value.trim() !== '', isRepliesArmed: page.arm()?.replies?.armed === true })
  p.bypassRow.hidden = !form.showBypass
  p.turnOnReplies.hidden = !form.needsReplies
  p.start.setAttribute('aria-disabled', String(!form.canStart))
  p.start.textContent = isOrbit ? 'Start' : 'Open in Claude'
  p.start.title = isOrbit ? 'Start in a terminal window (Ctrl+Enter). Claude may ask there to trust a new folder.' : 'Fill in a new session in Claude desktop; you press Enter there to start it (Ctrl+Enter)'
  const folderError = launchState.folder.error ? `${launchState.folder.error} Pick another folder or fix the path.` : ''
  p.folderInput.setAttribute('aria-invalid', String(folderState() === 'error'))
  if (p.folderError.textContent !== folderError) p.folderError.textContent = folderError
  p.folderError.hidden = !folderError
  if (launchState.folder.error && launchState.isPrefilled && launchState.folder.text === p.folderInput.value.trim()) {
    launchState.isPrefilled = false
    p.folderInput.value = ''
    launchState.folder = { text: '', info: null, error: null }
    return renderNew()
  }
  if (!launchState.isBusy) p.status.textContent = launchState.folder.error ? 'Fix the folder first.' : (form.why ?? '')
}

/** Opens New session (`c`, the header button or the palette), with the most recent folder filled in. */
export function openNewSession() {
  const p = newParts
  const folders = page.snapshot() ? recentFolders(page.snapshot(), 12) : []
  p.recent.replaceChildren(...folders.map(f => el('option', { value: f.path }, f.label)))
  launchState.isPrefilled = false
  if (!p.folderInput.value && folders[0]) {
    p.folderInput.value = folders[0].path
    launchState.isPrefilled = true
  }
  launchState.folder = { text: '', info: null, error: null }
  checkFolder(true)
  openDialog(p.dialog, p.folderInput, 'cx-new-open')
}

async function startNew() {
  const p = newParts
  if (launchState.isBusy || p.start.getAttribute('aria-disabled') === 'true') return
  launchState.isBusy = true
  renderNew()
  const isOrbit = p.where.value === 'orbit'
  const body = { folder: p.folderInput.value, prompt: p.prompt.value }
  p.status.textContent = isOrbit ? 'Starting…' : 'Opening Claude…'
  try {
    if (isOrbit) {
      const info = launchState.folder.info
      const result = await api('POST', '/api/launch', { ...body, digest: info?.digest, model: p.model.value, effort: p.effort.value, mode: p.mode.value, confirmBypass: p.bypass.checked })
      launchState.launches.push({ sessionId: result.sessionId, folder: info?.real ?? body.folder, startedAt: Date.now(), selectedAtLaunch: chat.selected, prompt: body.prompt.trim() ? 'held' : null, told: '' })
      if (p.mode.value === 'bypassPermissions') p.mode.value = ''
      p.bypass.checked = false
      p.prompt.value = ''
      launchState.isBusy = false
      p.dialog.close()
      page.toast(`Starting ${nameOf(info?.real ?? body.folder)}… answer Claude in the terminal if it asks.`)
      void pollPrompts()
      return
    }
    const sentFolder = p.folderInput.value.trim()
    const result = await api('POST', '/api/new', body)
    launchState.isBusy = false
    renderNew()
    const outcome = desktopOutcome(result.dryRun === true, body.prompt.trim() !== '', sentFolder)
    p.status.textContent = outcome
  } catch (error) {
    const link = handOffLink(error.detail)
    if (link) {
      location.assign(link)
      p.status.textContent = `${desktopOutcome(false, body.prompt.trim() !== '', p.folderInput.value.trim())} If Edge asks, allow it to open Claude.`
      return
    }
    p.status.textContent = isNoWindow(error.status, error.detail) ? NO_WINDOW_TEXT : `${error.message} Nothing was started.`
    if (error.detail?.reason === 'not-armed') await page.reloadArm()
    else if (error.status === 409) checkFolder(true)
  } finally {
    if (launchState.isBusy) {
      launchState.isBusy = false
      renderNew()
    }
  }
}

function nameOf(path) {
  return String(path).split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

async function pollPrompts() {
  clearTimeout(launchState.pollTimer)
  const waiting = launchState.launches.filter(l => l.prompt && !FINAL_PROMPT.has(l.prompt) && Date.now() - l.startedAt < LAUNCH_SHOWN_MS)
  if (!waiting.length) return
  for (const l of waiting) {
    try {
      const answer = await api('GET', `/api/launch/${l.sessionId}`)
      l.prompt = answer.prompt
    } catch (error) {
      if (error.status === 404) l.prompt = 'dropped'
    }
  }
  launchState.pollTimer = setTimeout(() => void pollPrompts(), 2_000)
}

/**
 * Called on every snapshot: a started session that arrived is selected when
 * that interrupts nothing, else announced with Show; one that has not
 * arrived after a minute is reported once.
 */
export function noteLaunches() {
  if (!launchState.launches.length) return
  const now = Date.now()
  const rows = launchStatus(launchState.launches, page.snapshot()?.sessions ?? [], now)
  for (const row of rows) {
    const launch = launchState.launches.find(l => l.sessionId === row.sessionId)
    if (!launch || launch.told === row.status || row.status === 'starting') continue
    launch.told = row.status
    const name = nameOf(row.folder)
    const prompt = promptStateText(launch.prompt)
    if (row.status === 'failed') page.toast(`${name} hasn’t started yet: check the terminal.`)
    else if (row.key) {
      const active = document.activeElement
      const isTyping = Boolean(active?.matches?.('input, textarea, select'))
      const hasDraft = chat.selected ? draftOf(chat.drafts, chat.selected.slice(2)).trim() !== '' : false
      if (mayAutoSelect({ isTyping, selectedNow: chat.selected, selectedAtLaunch: launch.selectedAtLaunch, hasDraft })) page.select(row.key)
      else page.toast(`${name} started${prompt ? ` · ${prompt}` : ''}.`, { label: 'Show', run: () => page.select(row.key) }, row.key)
    }
  }
  launchState.launches = launchState.launches.filter(l => now - l.startedAt < LAUNCH_SHOWN_MS && l.told !== 'arrived')
}

// Ctrl+K palette ------------------------------------------------------------

const paletteParts = { items: [], index: 0 }

function buildPalette() {
  const dialog = $('cx-palette')
  const input = el('input', { id: 'cx-p-input', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'cx-p-list', 'aria-autocomplete': 'list', 'aria-label': 'Go to a session or run an action', placeholder: 'Go to a session or run an action', autocomplete: 'off', spellcheck: 'false' })
  const list = el('div', { id: 'cx-p-list', role: 'listbox', 'aria-label': 'Results' })
  const status = el('p', { class: 'cx-hint', id: 'cx-p-status', role: 'status' })
  const hint = el('p', { class: 'cx-hint', id: 'cx-p-hint' }, 'Enter go · Ctrl+Enter open in Claude · Esc close')
  input.addEventListener('input', () => renderPalette(true))
  input.addEventListener('keydown', onPaletteKey)
  dialog.addEventListener('click', event => event.target === dialog && dialog.close())
  dialog.replaceChildren(input, list, el('div', { class: 'cx-p-foot' }, status, hint))
  Object.assign(paletteParts, { dialog, input, list, status })
}

export function openPalette() {
  if (!page.snapshot()) return
  paletteParts.actions = page.actions()
  paletteParts.input.value = ''
  renderPalette(true)
  openDialog(paletteParts.dialog, paletteParts.input)
}

function renderPalette(isNewQuery) {
  const p = paletteParts
  const snapshot = page.snapshot()
  const lookup = page.lookup()
  if (!snapshot || !lookup) return
  const now = Date.now()
  const hidden = page.prefs()?.hidden ?? {}
  const projectName = s => lookup.projects.get(s.projectId)?.name ?? ''
  const found = switcherResults(snapshot.sessions, hidden, p.input.value, projectName, page.attention(), 8)
  const rows = paletteResults(p.input.value, found.items, p.actions ?? [])
  const keep = isNewQuery ? -1 : rows.findIndex(r => rowId(r) === rowId(p.items[p.index] ?? null))
  p.items = rows
  p.index = keep >= 0 ? keep : 0
  const listed = new Set(page.listed())
  p.list.replaceChildren(
    ...rows.map((row, i) => {
      const hover = () => p.index !== i && ((p.index = i), markActive(false))
      if (row.kind === 'action') return el('div', { id: `cx-p-${i}`, class: 'cx-p-row is-action', role: 'option', 'aria-selected': 'false', onmousedown: e => e.preventDefault(), onmousemove: hover, onclick: () => choose(i, false) }, el('span', { class: 'cx-p-main' }, row.action.label), row.action.hotkey ? el('kbd', { class: 'key' }, row.action.hotkey) : null)
      const s = row.session
      const isHidden = isHiddenNow(s, hidden)
      const { meta, tag } = switcherRowMeta(s, projectName(s), now, { isHidden, isListed: listed.has(s.key) })
      return el(
        'div',
        { id: `cx-p-${i}`, class: `cx-p-row b-${bucketOfSession(s)}`, role: 'option', 'aria-selected': 'false', onmousedown: e => e.preventDefault(), onmousemove: hover, onclick: () => choose(i, false) },
        el('span', { class: `dot b-${bucketOfSession(s)}`, 'aria-hidden': 'true' }),
        el('span', { class: 'cx-p-main' }, el('span', { class: 'cx-p-title' }, truncate(s.title, 90)), el('span', { class: 'cx-p-meta' }, [page.reasonOf(s), meta].filter(Boolean).join(' · '))),
        tag ? el('span', { class: 'cx-p-tag' }, tag) : null,
      )
    }),
  )
  const actionCount = rows.filter(r => r.kind === 'action').length
  p.status.textContent = `${switcherStatus(found.total, found.hidden)}${actionCount ? ` · ${plural(actionCount, 'action')}` : ''}`
  p.input.setAttribute('aria-expanded', String(rows.length > 0))
  markActive(true)
}

function bucketOfSession(s) {
  return page.bucketOf(s)
}

function rowId(row) {
  return row ? (row.kind === 'action' ? `a:${row.action.id}` : `s:${row.session.key}`) : null
}

function markActive(shouldScroll) {
  const p = paletteParts
  const rows = p.list.querySelectorAll('.cx-p-row')
  rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === p.index)))
  const active = rows[p.index]
  if (active) {
    p.input.setAttribute('aria-activedescendant', active.id)
    if (shouldScroll) active.scrollIntoView({ block: 'nearest' })
  } else p.input.removeAttribute('aria-activedescendant')
}

function choose(index, openInClaude) {
  const row = paletteParts.items[index]
  if (!row) return
  paletteParts.dialog.close()
  if (row.kind === 'action') return page.runAction(row.action.id, row.action.key ?? null)
  const s = row.session
  if (isHiddenNow(s, page.prefs()?.hidden ?? {})) void page.unhide(s.key)
  if (openInClaude && s.canOpen) page.openInClaude(s.key)
  else page.select(s.key)
}

function onPaletteKey(event) {
  const p = paletteParts
  const count = p.items.length
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (count) {
      p.index = (p.index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
      markActive(true)
    }
  } else if ((event.key === 'Home' || event.key === 'End') && event.ctrlKey && count) {
    p.index = event.key === 'Home' ? 0 : count - 1
    markActive(true)
  } else if (event.key === 'Enter') choose(p.index, event.ctrlKey || event.metaKey)
  else return
  event.preventDefault()
}

/** Wires the dialogs to the page (`main.js` passes its state readers and actions). */
export function initSheets(pageApi) {
  page = pageApi
  buildSettings()
  buildNew()
  buildPalette()
}
