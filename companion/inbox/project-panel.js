import { ago, truncate } from '/shared/format.js'
import { statusLine, statusOf } from '/shared/popout.js'
import { sanitizePrefs } from '/shared/prefs.js'
import { icon } from './icons.js'
import { iconButton } from './actions.js'
import { projectTintOf, robotIcon, swatchGroup, tintColour, titleOf, TINT_NAMES } from './identity.js'
import { el, post, state } from './page-state.js'

/** The open project panel's parts, kept across redraws so focus survives live updates. */
let pp = null

/** The project id of the project panel showing, or null. */
export function projectPanelId() {
  return pp?.root.isConnected ? pp.id : null
}

/** Forgets the project panel, so the next session panel builds afresh. */
export function closeProjectPanel() {
  pp = null
}

/**
 * The panel for one project: its folder icon in the project's colour, its
 * facts, the default icon colour of its sessions, and its sessions, each
 * opening its own panel.
 * @param {HTMLElement} panel
 * @param {string} projectId the project id, without the map's `p:`
 * @param {{ select: (key: string, invoker: Element | null) => void, close: () => void }} actions
 */
export function renderProjectPanel(panel, projectId, actions) {
  if (!pp || pp.id !== projectId || !pp.root.isConnected) {
    pp = { id: projectId, sig: '', note: '', busy: false, actions, root: el('div', { class: 'cx-project' }) }
    panel.replaceChildren(pp.root)
  }
  pp.actions = actions
  const project = state.lookup?.projects.get(projectId) ?? null
  const sessions = (project?.sessionKeys ?? [])
    .map(k => state.lookup?.sessions.get(k))
    .filter(Boolean)
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
  const tint = projectTintOf(projectId)
  const sig = JSON.stringify([project?.name, project?.root, project?.remote, project?.lastActivityAt, tint, pp.note, pp.busy, sessions.map(s => [s.key, titleOf(s), s.tint, state.prefs?.tints?.[s.key], statusOf(s).bucket, statusOf(s).reason])])
  if (sig === pp.sig) return
  pp.sig = sig
  const active = document.activeElement
  const hadFocus = pp.root.contains(active) ? (active.id || (active.dataset?.key ? `[data-key="${CSS.escape(active.dataset.key)}"]` : active.matches('input[type="radio"]') ? 'input[type="radio"]:checked' : null)) : null
  pp.root.replaceChildren(el('div', { class: 'cx-panel-top' }, ...content(project, projectId, sessions, tint)))
  if (hadFocus) (pp.root.querySelector(hadFocus.startsWith('[') || hadFocus.startsWith('input') ? hadFocus : `#${CSS.escape(hadFocus)}`) ?? pp.root.querySelector('h2'))?.focus({ preventScroll: true })
}

function content(project, projectId, sessions, tint) {
  const counts = { working: 0, 'needs-you': 0 }
  for (const s of sessions) {
    const bucket = statusOf(s).bucket
    if (bucket in counts) counts[bucket] += 1
  }
  const summary = [`${sessions.length} session${sessions.length === 1 ? '' : 's'}`, counts.working ? `${counts.working} working` : null, counts['needs-you'] ? `${counts['needs-you']} need${counts['needs-you'] === 1 ? 's' : ''} you` : null].filter(Boolean).join(' · ')
  const folder = icon('folder', 'cx-project-icon')
  folder.style.color = tintColour(tint)
  const fact = (name, value, label) => el('div', { class: 'cx-fact', title: label }, icon(name), el('span', { class: 'sr-only' }, `${label}: `), el('span', {}, value))
  return [
    el(
      'header',
      { class: 'cx-panel-head' },
      el('div', {}, el('h2', { id: 'cx-panel-title', tabindex: '-1' }, folder, el('span', {}, truncate(project?.name ?? 'Project', 120))), el('p', { class: 'cx-status-line' }, el('span', {}, project ? 'Project' : 'No longer in Orbit'), project ? el('span', { class: 'muted' }, summary) : null)),
      iconButton('close', 'Close (Esc)', () => pp.actions.close(), { class: 'ghost cx-close' }),
    ),
    project
      ? el(
          'div',
          { class: 'cx-fact-grid' },
          fact('folder', project.root, 'Folder'),
          project.remote ? fact('remote', project.remote, 'Remote') : null,
          project.lastActivityAt ? fact('clock', `Active ${ago(Date.now() - project.lastActivityAt)} ago`, 'Last active') : null,
        )
      : null,
    el(
      'section',
      { class: 'cx-section cx-project-colour' },
      swatchGroup({ name: 'cx-project-tint', legend: 'Session icon colour', current: tint, onPick: value => void saveTint(projectId, value) }),
      el('p', { class: 'cx-note' }, 'Its sessions use this colour unless you pick one for a session.'),
      pp.note ? el('p', { class: 'err', role: 'alert' }, pp.note) : null,
    ),
    el(
      'section',
      { class: 'cx-section cx-project-sessions', 'aria-labelledby': 'cx-project-sessions-title' },
      el('h3', { class: 'h-title', id: 'cx-project-sessions-title' }, icon('session', 'accent'), el('span', {}, 'Sessions'), el('span', { class: 'h-count' }, String(sessions.length))),
      sessions.length
        ? el(
            'ul',
            { class: 'cx-agents-list' },
            ...sessions.map(s => {
              const st = statusOf(s)
              return el(
                'li',
                {},
                el(
                  'button',
                  { class: 'cx-agent-row', type: 'button', 'data-key': s.key, onclick: event => pp.actions.select(s.key, event.currentTarget) },
                  robotIcon(s),
                  el('span', { class: 't' }, truncate(titleOf(s), 80)),
                  el('span', { class: 'meta' }, statusLine(st, Date.now())),
                ),
              )
            }),
          )
        : el('p', { class: 'cx-note' }, 'No sessions in Orbit.'),
    ),
  ]
}

async function saveTint(projectId, value) {
  if (!pp || pp.busy) return
  pp.busy = true
  pp.note = ''
  const before = state.prefs
  if (state.prefs) state.prefs = { ...state.prefs, projectTints: { ...(state.prefs.projectTints ?? {}), [projectId]: value } }
  rerender()
  try {
    const answer = await post('/api/prefs', { projectTints: { [projectId]: value === 'blue' ? null : value } })
    if (answer?.prefs) state.prefs = sanitizePrefs(answer.prefs)
  } catch {
    state.prefs = before
    if (pp?.id === projectId) pp.note = `Couldn’t save ${TINT_NAMES[value] ?? value}. Try again.`
  }
  if (pp) pp.busy = false
  rerender()
}

function rerender() {
  if (!pp?.root.isConnected) return
  pp.sig = ''
  renderProjectPanel(/** @type {HTMLElement} */ (pp.root.parentElement), pp.id, pp.actions)
  pp.actions.repaint?.()
}
