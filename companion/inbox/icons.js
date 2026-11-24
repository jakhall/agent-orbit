// @ts-check

import { KIND_ICONS } from '/shared/map.js'

const ICONS = {
  robot: KIND_ICONS.session,
  fork: KIND_ICONS.fork,
  subagent: KIND_ICONS.agent,
  folder: '<path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
  branch: '<circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="5.5" r="1.5"/><path d="M5 5v6M11 7c0 2.5-6 1.5-6 4"/>',
  model: '<rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
  turns: '<path d="M3 4.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7l-3 2.5v-2.5H4a1 1 0 0 1-1-1z"/>',
  agents: '<circle cx="6" cy="6" r="2.2"/><path d="M2.5 13c.4-2 1.8-3.2 3.5-3.2s3.1 1.2 3.5 3.2"/><circle cx="11.2" cy="6.8" r="1.7"/><path d="M10.5 9.9c1.6.1 2.6 1.2 3 3.1"/>',
  activity: '<path d="M2 8h2.5l1.5-3.5 2.5 7 1.5-3.5H14"/>',
  objective: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/>',
  session: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6h11"/>',
  hidden: '<circle cx="4" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12" cy="8" r="1"/>',
  alert: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.3v.2"/>',
  failed: '<circle cx="8" cy="8" r="5.5"/><path d="m6 6 4 4M10 6l-4 4"/>',
  'remote-control': '<rect x="2.5" y="4" width="6" height="9.5" rx="1.2"/><path d="M5 11.5h1M10.5 6.5a2.5 2.5 0 0 1 0 3.5M12.5 4.5a5.3 5.3 0 0 1 0 7.5"/>',
  pin: '<path d="M6 2.5h4l-.5 4 2 2v1H4.5v-1l2-2z"/><path d="M8 9.5v4"/>',
  check: '<circle cx="8" cy="8" r="5.5"/><path d="m5.6 8.2 1.7 1.7 3.2-3.4"/>',
  done: '<path d="m3.5 8.5 3 3 6-7"/>',
  bolt: '<path d="M9.2 1.8 3.8 9h4l-1 5.2L12.2 7h-4z"/>',
  flag: '<path d="M3.5 13.5V3M3.5 3h8l-1.6 2.6 1.6 2.6h-8"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.3v3.5M8 5.2v.2"/>',
  chevron: '<path d="m6 4 4 4-4 4"/>',
  down: '<path d="m4 6 4 4 4-4"/>',
  open: '<path d="M9 3h4v4M13 3 7.5 8.5"/><path d="M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  minus: '<path d="M3.5 8h9"/>',
  fit: '<path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"/>',
  arrange: '<circle cx="8" cy="8" r="1.7"/><circle cx="3.3" cy="3.3" r="1.3"/><circle cx="12.7" cy="3.3" r="1.3"/><circle cx="3.3" cy="12.7" r="1.3"/><circle cx="12.7" cy="12.7" r="1.3"/><path d="m4.4 4.4 2.2 2.2M11.6 4.4 9.4 6.6M4.4 11.6l2.2-2.2M11.6 11.6 9.4 9.4"/>',
  filter: '<path d="M2.5 3.5h11l-4.2 5v4l-2.6 1.2V8.5z"/>',
  sliders: '<path d="M3 5h6M11.5 5H13M3 11h1.5M7.5 11H13"/><circle cx="10" cy="5" r="1.5"/><circle cx="6" cy="11" r="1.5"/>',
  graph: '<circle cx="4" cy="11.5" r="1.6"/><circle cx="12" cy="11.5" r="1.6"/><circle cx="8" cy="4" r="1.6"/><path d="M4.8 10 7.2 5.5M11.2 10 8.8 5.5M5.6 11.5h4.8"/>',
  list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5"/>',
  copy: '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2"/><path d="M10.5 5.5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h1.5"/>',
  eye: '<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.8"/>',
  eyeoff: '<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z"/><path d="M2.5 2.5l11 11"/>',
  moon: '<path d="M13 9.6A5.5 5.5 0 1 1 6.4 3a4.5 4.5 0 0 0 6.6 6.6z"/>',
  snooze: '<circle cx="8" cy="8.5" r="5"/><path d="M8 6v2.5l1.6 1.2M3 3.5l1.6-1.2M13 3.5l-1.6-1.2"/>',
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor"/>',
  send: '<path d="M2.5 8 13.5 3 10 13.5 7.5 9z"/><path d="M7.5 9 13.5 3"/>',
  reply: '<path d="M6.5 4 3 7.5 6.5 11"/><path d="M3 7.5h6.5a3.5 3.5 0 0 1 3.5 3.5v1"/>',
  edit: '<path d="M10.5 3.5l2 2L6 12H4v-2z"/>',
  reset: '<path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2"/><path d="M3.5 3v2.5H6"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  diff: '<path d="M5.5 2.5v6M2.5 5.5h6M8 12.5h5.5"/>',
  person: '<circle cx="8" cy="5.2" r="2.6"/><path d="M2.8 13.6c.5-2.7 2.6-4.3 5.2-4.3s4.7 1.6 5.2 4.3"/>',
  claude: '<path d="M8 1.8v4M8 10.2v4M1.8 8h4M10.2 8h4M3.6 3.6l2.8 2.8M9.6 9.6l2.8 2.8M12.4 3.6 9.6 6.4M6.4 9.6l-2.8 2.8"/>',
  pr: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7.5M9 3 7.5 4.5 9 6"/>',
  remote: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.7 1.6 2.5 3.4 2.5 5.5S9.7 11.9 8 13.5C6.3 11.9 5.5 10.1 5.5 8S6.3 4.1 8 2.5z"/>',
  more: '<circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  hub: '<path d="M8 2.2 13 5.1v5.8L8 13.8 3 10.9V5.1z"/>',
  diamond: '<path d="M8 3.2 12.8 8 8 12.8 3.2 8z"/>',
}

/** The icon names a section or group heading uses; each is a key of the icon set. */
export const GROUP_ICON = { 'needs-you': 'alert', failed: 'failed', review: 'check', working: 'activity', idle: 'clock' }

/**
 * A 14 px line icon from the fixed set (static markup only, never data), in
 * the colour of the text around it; `variant` adds a class such as `accent`.
 * @param {string} name
 * @param {string | null} [variant]
 * @returns {HTMLSpanElement}
 */
export function icon(name, variant = null) {
  const span = document.createElement('span')
  span.className = variant ? `icon ${variant}` : 'icon'
  span.setAttribute('aria-hidden', 'true')
  span.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`
  return span
}

/**
 * Puts the named icon into an existing button and gives it the `icon-btn`
 * look, keeping its `title` as the tooltip and its `aria-label` as the name.
 * @param {HTMLElement | null} button
 * @param {string} name
 */
export function iconInto(button, name) {
  if (!button) return
  button.classList.add('icon-btn')
  button.replaceChildren(icon(name))
}
