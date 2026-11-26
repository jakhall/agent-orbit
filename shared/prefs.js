// @ts-check

import { DEFAULT_FILTERS, DEFAULT_SETTINGS, MAX_HIDDEN, MAX_PINNED, SESSION_TINTS, TIME_PRESETS, TITLE_MAX } from './constants.js'
import { cleanHidden } from './filters.js'
import { sanitizeSkillShelf } from './skills.js'

/** @typedef {import('../types').Prefs} Prefs */
/** @typedef {import('../types').Settings} Settings */
/** @typedef {import('../types').Filters} Filters */
/** @typedef {import('../types').Offset} Offset */
/** @typedef {import('../types').TimePreset} TimePreset */

const MAX_POSITIONS = 2000

/**
 * @template T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @param {T} fallback
 * @returns {T}
 */
function pick(value, allowed, fallback) {
  return allowed.includes(/** @type {T} */ (value)) ? /** @type {T} */ (value) : fallback
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInt(value, min, max, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function record(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : {}
}

/**
 * @param {unknown} raw
 * @returns {Settings}
 */
function sanitizeSettings(raw) {
  const s = record(raw)
  const d = DEFAULT_SETTINGS
  return {
    animation: pick(s.animation, /** @type {const} */ (['off', 'low', 'normal']), d.animation),
    refreshSec: clampInt(s.refreshSec, 5, 60, d.refreshSec),
    maxSessions: clampInt(s.maxSessions, 10, 300, d.maxSessions),
    maxSubagents: clampInt(s.maxSubagents, 0, 64, d.maxSubagents),
    simplified: bool(s.simplified, d.simplified),
    paused: bool(s.paused, d.paused),
    staleMinutes: clampInt(s.staleMinutes, 2, 240, d.staleMinutes),
    showPRs: bool(s.showPRs, d.showPRs),
    prProblemsNeedYou: bool(s.prProblemsNeedYou, d.prProblemsNeedYou ?? false),
  }
}

/**
 * @param {unknown} raw
 * @returns {Filters}
 */
function sanitizeFilters(raw) {
  const f = record(raw)
  const d = DEFAULT_FILTERS
  return {
    time: pick(f.time, /** @type {TimePreset[]} */ (TIME_PRESETS.map(p => p.value)), d.time),
    showCompleted: bool(f.showCompleted, d.showCompleted),
    showStale: bool(f.showStale, d.showStale),
    attentionOnly: bool(f.attentionOnly, d.attentionOnly),
    project: text(f.project, 500),
    model: text(f.model, 100),
    lifecycle: text(f.lifecycle, 40),
    phase: text(f.phase, 40),
    search: text(f.search, 200),
  }
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string[]}
 */
function strings(value, max) {
  return Array.isArray(value) ? [...new Set(value.filter(v => typeof v === 'string' && v.length <= 600))].slice(0, max) : []
}

/**
 * The shared preferences as every reader and writer must see them: known
 * keys only, each with its type and range, defaults for the rest. Used by
 * the mod, the pop-out server before it writes, and the page after it reads.
 * @param {unknown} raw
 * @returns {Prefs}
 */
export function sanitizePrefs(raw) {
  const p = record(raw)
  /** @type {Record<string, Offset>} */
  const positions = {}
  for (const [id, value] of Object.entries(record(p.positions)).slice(-MAX_POSITIONS)) {
    const v = record(value)
    if (typeof v.dx === 'number' && typeof v.dy === 'number' && Number.isFinite(v.dx) && Number.isFinite(v.dy)) {
      positions[id] = { dx: Math.round(v.dx * 10) / 10, dy: Math.round(v.dy * 10) / 10 }
    }
  }
  return {
    schema: 1,
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
    settings: sanitizeSettings(p.settings),
    filters: sanitizeFilters(p.filters),
    positions,
    collapsed: strings(p.collapsed, 500),
    pinned: strings(p.pinned, MAX_PINNED),
    hidden: cleanHidden(p.hidden, MAX_HIDDEN),
    projectOverrides: cleanOverrides(p.projectOverrides),
    titles: cleanTitles(p.titles),
    skillShelf: sanitizeSkillShelf(p.skillShelf),
    tints: cleanTints(p.tints, true),
    projectTints: cleanTints(p.projectTints, false),
    done: cleanDone(p.done),
    snoozed: cleanSnoozed(p.snoozed),
    clearedAt: typeof p.clearedAt === 'number' && Number.isFinite(p.clearedAt) ? p.clearedAt : 0,
  }
}

const MAX_OVERRIDES = 500

/**
 * Session key → project id, both short plain strings (G-17).
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function cleanOverrides(raw) {
  /** @type {Record<string, string>} */
  const out = {}
  const entries = Object.entries(record(raw)).filter(([key, value]) => key !== '__proto__' && key.length > 0 && key.length <= 600 && typeof value === 'string' && value.trim().length > 0 && value.length <= 400)
  for (const [key, value] of entries.slice(-MAX_OVERRIDES)) out[key] = /** @type {string} */ (value).trim()
  return out
}

/**
 * A name a person typed for a session: one line, spaces collapsed, at most
 * `TITLE_MAX` characters; null when nothing is left.
 * @param {unknown} value
 * @returns {string | null}
 */
export function cleanTitle(value) {
  if (typeof value !== 'string') return null
  const text = value.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
  return text ? [...text].slice(0, TITLE_MAX).join('').trim() : null
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function cleanTitles(raw) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(record(raw)).slice(-MAX_OVERRIDES)) {
    const title = cleanTitle(value)
    if (key !== '__proto__' && key.length > 0 && key.length <= 600 && title) out[key] = title
  }
  return out
}

/**
 * Key → icon colour. A session may keep an explicit blue (it overrides its
 * project's colour); a project's blue is the default, so it is dropped.
 * @param {unknown} raw
 * @param {boolean} keepBlue
 * @returns {NonNullable<Prefs['tints']>}
 */
function cleanTints(raw, keepBlue) {
  /** @type {NonNullable<Prefs['tints']>} */
  const out = {}
  for (const [key, value] of Object.entries(record(raw)).slice(-MAX_OVERRIDES)) {
    if (key !== '__proto__' && key.length > 0 && key.length <= 600 && (keepBlue || value !== 'blue') && SESSION_TINTS.includes(/** @type {never} */ (value))) out[key] = /** @type {any} */ (value)
  }
  return out
}

const MAX_MARKS = 500

/**
 * @param {[string, unknown]} entry
 * @returns {boolean}
 */
const isMarkKey = ([key]) => key !== '__proto__' && key.length > 0 && key.length <= 600
const isTime = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * Session key → when the person marked it Done (C6); the newest 500.
 * @param {unknown} raw
 * @returns {Record<string, number>}
 */
function cleanDone(raw) {
  const entries = /** @type {[string, number][]} */ (Object.entries(record(raw)).filter(e => isMarkKey(e) && isTime(e[1])))
  return Object.fromEntries(entries.sort((a, b) => a[1] - b[1]).slice(-MAX_MARKS))
}

/**
 * Session key → `{ until, at }`: snoozed at `at` until `until` (C6); the newest 500.
 * @param {unknown} raw
 * @returns {Record<string, { until: number, at: number }>}
 */
function cleanSnoozed(raw) {
  /** @type {[string, { until: number, at: number }][]} */
  const entries = []
  for (const entry of Object.entries(record(raw))) {
    const v = record(entry[1])
    if (isMarkKey(entry) && isTime(v.until) && isTime(v.at) && /** @type {number} */ (v.until) > /** @type {number} */ (v.at)) entries.push([entry[0], { until: /** @type {number} */ (v.until), at: /** @type {number} */ (v.at) }])
  }
  return Object.fromEntries(entries.sort((a, b) => a[1].at - b[1].at).slice(-MAX_MARKS))
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Applies a Done, Snooze or Hide patch (C6), as `donePatch` and `snoozePatch`
 * build it: `done` and `snoozed` merge per session key, a null clearing the
 * key; `hidden` replaces the map. The server's `/api/prefs` and the pane use
 * the same merge; the caller sanitises the result.
 * @template {{ done?: unknown, snoozed?: unknown, hidden?: unknown }} P
 * @param {P} prefs
 * @param {{ done?: unknown, snoozed?: unknown, hidden?: unknown }} patch
 * @returns {P}
 */
export function applyMarks(prefs, patch) {
  let next = prefs
  if (isMap(patch.hidden)) next = { ...next, hidden: cleanHidden(patch.hidden, MAX_HIDDEN) }
  for (const field of /** @type {const} */ (['done', 'snoozed'])) {
    const changes = patch[field]
    if (!isMap(changes)) continue
    /** @type {Record<string, unknown>} */
    const marks = { ...(isMap(next[field]) ? next[field] : {}) }
    for (const [key, value] of Object.entries(changes)) {
      if (key === '__proto__' || key.length > 600) continue
      delete marks[key]
      if (value !== null) marks[key] = value
    }
    next = { ...next, [field]: marks }
  }
  return next
}

/** @returns {Prefs} */
export function defaultPrefs() {
  return sanitizePrefs({})
}
