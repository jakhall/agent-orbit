import fs from 'node:fs'

import { MAX_PINNED } from '../../shared/constants.js'
import { applyMarks, sanitizePrefs } from '../../shared/prefs.js'
import { FILES, log, pause, writeAtomic } from './runtime.mjs'

const PREFS_SETTLE_MS = 10_000

/**
 * The prefs file for a read-modify-write: `{}` when missing, null while it
 * cannot be read or parsed (another writer mid-write). A file that still
 * does not parse after PREFS_SETTLE_MS is backed up to `prefs.json.bad` and
 * read as `{}`, so one torn write cannot refuse every later save.
 */
function readPrefsForUpdate() {
  let text = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      text = fs.readFileSync(FILES.prefs, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      Atomics.wait(pause, 0, 0, 30)
      continue
    }
    try {
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      Atomics.wait(pause, 0, 0, 30)
    }
  }
  const age = Date.now() - (fs.statSync(FILES.prefs, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
  if (text === null || age < PREFS_SETTLE_MS) return null
  writeAtomic(`${FILES.prefs}.bad`, text)
  log('prefs.json did not parse for 10 s; backed up to prefs.json.bad and rewritten')
  return {}
}

export function mergePrefs(patch) {
  const prefs = readPrefsForUpdate()
  if (prefs === null) throw Object.assign(new Error('preferences are being written by another window'), { status: 503 })
  const next = { ...prefs, schema: 1 }
  if (patch.resetLayout === true) Object.assign(next, { positions: {}, collapsed: [] })
  if (patch.resetPositions === true) next.positions = {}
  if (patch.positions && typeof patch.positions === 'object') {
    const positions = { ...(next.positions ?? {}) }
    for (const [id, value] of Object.entries(patch.positions)) {
      if (typeof id !== 'string' || id.length > 600) continue
      delete positions[id]
      if (value !== null && Number.isFinite(value?.dx) && Number.isFinite(value?.dy)) positions[id] = { dx: Math.round(value.dx * 10) / 10, dy: Math.round(value.dy * 10) / 10 }
    }
    next.positions = positions
  }
  if (Array.isArray(patch.collapsed)) next.collapsed = patch.collapsed.filter(v => typeof v === 'string' && v.length <= 600).slice(0, 500)
  if (Array.isArray(patch.pinned)) next.pinned = [...new Set(patch.pinned.filter(v => typeof v === 'string' && v.length <= 600))].slice(0, MAX_PINNED)
  Object.assign(next, applyMarks(next, patch))
  for (const group of ['projectOverrides', 'titles', 'tints', 'projectTints']) {
    const changes = patch[group]
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) continue
    const merged = { ...(next[group] ?? {}) }
    for (const [key, value] of Object.entries(changes)) {
      if (key === '__proto__' || key.length > 600) continue
      delete merged[key]
      if (typeof value === 'string') merged[key] = value
    }
    next[group] = merged
  }
  for (const group of ['filters', 'settings']) {
    if (patch[group] && typeof patch[group] === 'object') {
      next[group] = { ...(next[group] ?? {}) }
      for (const [k, v] of Object.entries(patch[group])) {
        if (['string', 'number', 'boolean'].includes(typeof v) && String(v).length <= 500) next[group][k] = v
      }
    }
  }
  const clean = sanitizePrefs({ ...next, updatedAt: Date.now() })
  writeAtomic(FILES.prefs, JSON.stringify({ ...prefs, ...clean }, null, 1))
  return clean
}
