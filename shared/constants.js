// @ts-check

/** @typedef {import('../types').Settings} Settings */
/** @typedef {import('../types').Filters} Filters */
/** @typedef {import('../types').Lifecycle} Lifecycle */
/** @typedef {import('../types').Phase} Phase */
/** @typedef {import('../types').TimePreset} TimePreset */
/** @typedef {import('../types').AttentionKind} AttentionKind */

export const MOD_VERSION = '2.3.0'
export const APP_NAME = 'Orbit'
export const MAX_PROMPT_CHARS = 4000
export const MAX_MESSAGE_CHARS = 4000
export const MAX_PINNED = 200
export const MAX_HIDDEN = 200
/** Windows caps a command line at 32,767 characters; the link rides on one. */
export const MAX_LINK_CHARS = 30000

/** The one colour source: the pop-out page's CSS variables are generated from it. */
export const PALETTE = {
  bg: '#0B0C0E',
  surface: '#111214',
  raised: '#1B1D21',
  bg2: '#141518',
  bg3: '#1B1D21',
  hover: '#22252A',
  line: '#26292E',
  lineStrong: '#3C4048',
  controlEdge: '#656B76',
  text: '#E4E6EA',
  label: '#C3C7CE',
  muted: '#8B9099',
  faint: '#7C818A',
  grey: '#80858E',
  accent: '#6C93E8',
  onAccent: '#0B0C0E',
  amber: '#FF7A1F',
  green: '#2FD58F',
  coral: '#E06464',
  dim: '#676B73',
  tintViolet: '#A47BFF',
  tintPink: '#FF5CB4',
  tintRed: '#FF4D4D',
  tintTeal: '#14E0C8',
  tintLime: '#A8E22E',
  tintSand: '#F2B84B',
  tintSlate: '#8EA9D6',
}

/** The light theme: the same keys as `PALETTE` (DESIGN.md `-light` values). */
export const PALETTE_LIGHT = {
  bg: '#F7F8FA',
  surface: '#FFFFFF',
  raised: '#EEF0F3',
  bg2: '#F7F8FA',
  bg3: '#EEF0F3',
  hover: '#EAEDF1',
  line: '#DADDE3',
  lineStrong: '#BCC1CA',
  controlEdge: '#858A93',
  text: '#16181D',
  label: '#3D424B',
  muted: '#5B616C',
  faint: '#5F6570',
  grey: '#7A808A',
  accent: '#2F5FC4',
  onAccent: '#FFFFFF',
  amber: '#D9560A',
  green: '#0E8F5A',
  coral: '#C94A4A',
  dim: '#858B95',
  tintViolet: '#6B38F0',
  tintPink: '#D6177F',
  tintRed: '#D42020',
  tintTeal: '#00877A',
  tintLime: '#4A8500',
  tintSand: '#9C6A00',
  tintSlate: '#3F64A8',
}

/** A session's icon colours (DESIGN.md "Session colours"): blue is the accent and the default. */
export const SESSION_TINTS = /** @type {const} */ (['blue', 'violet', 'pink', 'red', 'teal', 'lime', 'sand', 'slate'])
/** @typedef {typeof SESSION_TINTS[number]} SessionTint */

/** The longest name a person can give a session in Orbit. */
export const TITLE_MAX = 120

/**
 * The palette key that draws a session's icon colour.
 * @param {string | null | undefined} tint
 * @returns {string}
 */
export function tintKey(tint) {
  return tint && tint !== 'blue' && SESSION_TINTS.includes(/** @type {SessionTint} */ (tint)) ? `tint${tint.charAt(0).toUpperCase()}${tint.slice(1)}` : 'accent'
}

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  animation: 'off',
  refreshSec: 10,
  maxSessions: 50,
  maxSubagents: 8,
  simplified: false,
  paused: false,
  staleMinutes: 10,
  showPRs: false,
  prProblemsNeedYou: false,
}

/** @type {Filters} */
export const DEFAULT_FILTERS = {
  time: '24h',
  showCompleted: true,
  showStale: true,
  attentionOnly: false,
  project: '',
  model: '',
  lifecycle: '',
  phase: '',
  search: '',
}

/** @type {{ value: TimePreset, label: string, ms: number | null }[]} */
export const TIME_PRESETS = [
  { value: 'active', label: 'Active now', ms: null },
  { value: '15m', label: 'Last 15 minutes', ms: 15 * 60_000 },
  { value: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { value: '4h', label: 'Last 4 hours', ms: 4 * 60 * 60_000 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 },
  { value: 'all', label: 'All sessions', ms: null },
]

/**
 * `color` is the status dot (graph centre dot, list and panel dots); `dot` is
 * the desktop theme name for the same dot in the pane; `theme` is the pane's
 * text colour. Colour lives only in dots: amber needs you, green complete,
 * blue running, coral failed. Text stays neutral.
 * @type {Record<Lifecycle, { label: string, color: string, glyph: string, theme: string, dot: string }>}
 */
export const LIFECYCLE = {
  running: { label: 'Running', color: PALETTE.accent, glyph: 'â€º', theme: 'text', dot: 'suggestion' },
  'waiting-user': { label: 'Waiting for you', color: PALETTE.amber, glyph: '?', theme: 'text', dot: 'warning' },
  'waiting-permission': { label: 'Needs permission', color: PALETTE.amber, glyph: '!', theme: 'text', dot: 'warning' },
  idle: { label: 'Idle', color: PALETTE.dim, glyph: 'Â·', theme: 'subtle', dot: 'subtle' },
  completed: { label: 'Completed', color: PALETTE.green, glyph: 'âœ“', theme: 'subtle', dot: 'success' },
  interrupted: { label: 'Interrupted', color: PALETTE.dim, glyph: 'â€–', theme: 'subtle', dot: 'subtle' },
  failed: { label: 'Failed', color: PALETTE.coral, glyph: 'Ã—', theme: 'subtle', dot: 'error' },
  disconnected: { label: 'Disconnected', color: PALETTE.dim, glyph: 'âŒ', theme: 'inactive', dot: 'inactive' },
  stale: { label: 'Stale', color: PALETTE.dim, glyph: 'â€¦', theme: 'inactive', dot: 'inactive' },
  unknown: { label: 'Unknown', color: PALETTE.dim, glyph: 'â€“', theme: 'inactive', dot: 'inactive' },
}

/** States that carry a centre dot on the graph; the rest are a bare ring. */

/** Lifecycles drawn as degraded: dashed stroke, muted labels. */
export const DEGRADED = /** @type {Lifecycle[]} */ (['stale', 'disconnected', 'interrupted', 'unknown'])

/** @type {Record<AttentionKind, { label: string, isUrgent: boolean, rank: number, color: string, theme: string, glyph: string, dot: string }>} */
export const ATTENTION = {
  permission: { label: 'Needs permission', isUrgent: true, rank: 0, color: PALETTE.amber, theme: 'text', glyph: '!', dot: 'warning' },
  question: { label: 'Asked a question', isUrgent: true, rank: 1, color: PALETTE.amber, theme: 'text', glyph: '?', dot: 'warning' },
  'needs-you': { label: 'Needs you', isUrgent: true, rank: 2, color: PALETTE.amber, theme: 'text', glyph: '!', dot: 'warning' },
  failed: { label: 'Failed', isUrgent: true, rank: 3, color: PALETTE.amber, theme: 'text', glyph: 'Ã—', dot: 'warning' },
  blocked: { label: 'Blocked', isUrgent: true, rank: 4, color: PALETTE.amber, theme: 'text', glyph: 'âŠ˜', dot: 'warning' },
  pr: { label: 'PR needs you', isUrgent: true, rank: 5, color: PALETTE.amber, theme: 'text', glyph: '!', dot: 'warning' },
  review: { label: 'Ready for review', isUrgent: false, rank: 6, color: PALETTE.green, theme: 'text', glyph: 'âœ“', dot: 'success' },
}

export const ACTIVE_LIFECYCLES = /** @type {Lifecycle[]} */ (['running', 'waiting-user', 'waiting-permission'])

/** Sources of a status, in words. */
export const SOURCE_LABEL = {
  'mod-events': 'live session events',
  'desktop-metadata': 'desktop session record',
  'desktop-summary': "the app's post-turn summary",
  'subagent-meta': 'subagent metadata',
  github: 'GitHub (gh)',
  'orbit-hook': "Orbit's permission hook",
  none: 'no source',
}
