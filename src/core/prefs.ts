import type { EngineInterface } from 'claude-code'

import type { Prefs } from '../../types'
import { sanitizePrefs } from '../../shared/prefs.js'
import { errorText, readJson } from '../paths'

export { defaultPrefs, sanitizePrefs } from '../../shared/prefs.js'

export async function loadPrefs($: EngineInterface, path: string): Promise<Prefs> {
  return sanitizePrefs(await readJson<unknown>($, path))
}

const PREFS_SETTLE_MS = 10_000

/**
 * The shared prefs for a reader that already holds some: a file that exists
 * but does not parse keeps `current` (`isBroken`), since another writer may
 * be mid-write; once such a file is older than PREFS_SETTLE_MS it is backed
 * up to `<path>.bad` and rewritten with `current`. A missing file is defaults.
 */
export async function readPrefsFile($: EngineInterface, path: string, current: Prefs, now: number): Promise<{ prefs: Prefs; isBroken: boolean }> {
  let text: string
  try {
    text = await $.fs.read(path)
  } catch {
    const exists = await $.fs.exists(path).catch(() => true)
    return exists ? { prefs: current, isBroken: true } : { prefs: sanitizePrefs({}), isBroken: false }
  }
  try {
    return { prefs: sanitizePrefs(JSON.parse(text)), isBroken: false }
  } catch {
    const stat = await $.fs.stat(path).catch(() => null)
    if (stat && now - stat.mtimeMs >= PREFS_SETTLE_MS) {
      try {
        await $.fs.write(`${path}.bad`, text)
        await $.fs.write(path, JSON.stringify(current, null, 1))
      } catch {
        return { prefs: current, isBroken: true }
      }
    }
    return { prefs: current, isBroken: true }
  }
}

/**
 * The file as it stands for a read-modify-write: defaults when it does not
 * exist, null when it exists but cannot be read (another writer mid-write),
 * so the caller does not overwrite it with defaults.
 */
async function readForUpdate($: EngineInterface, path: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let raw: string
    try {
      raw = await $.fs.read(path)
    } catch {
      return (await $.fs.exists(path).catch(() => true)) ? null : {}
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      continue
    }
  }
  return null
}

/**
 * Read-modify-write of the shared prefs file: the pane and the companion
 * window both write it, so each change re-reads the file first. Fields this
 * version does not know (a newer version's) are written back unchanged.
 */
export async function savePrefs($: EngineInterface, path: string, change: (prefs: Prefs) => Prefs): Promise<{ prefs: Prefs; error: string | null }> {
  const raw = await readForUpdate($, path)
  if (!raw) return { prefs: sanitizePrefs(change(await loadPrefs($, path))), error: 'the preferences file is being written by another window; try again' }
  const next = sanitizePrefs({ ...change(sanitizePrefs(raw)), updatedAt: await $.clock.now() })
  try {
    await $.fs.write(path, JSON.stringify({ ...raw, ...next }, null, 1))
    return { prefs: next, error: null }
  } catch (error) {
    return { prefs: next, error: errorText(error) }
  }
}
