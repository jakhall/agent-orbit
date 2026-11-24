// @ts-check

import { lastEntryAt, TRANSCRIPT_MAX_BYTES } from '../conversation.js'
import { joinWith } from './path-utils.js'

/** @typedef {import('./path-utils.js').Host} Host */

/**
 * @typedef {object} SubagentMeta
 * @property {string} id
 * @property {string} type
 * @property {string} description
 * @property {string | null} model
 * @property {boolean | null} finished
 * @property {number | null} lastActivityAt
 */

/**
 * @typedef {object} RawMeta
 * @property {unknown} [agentType]
 * @property {unknown} [description]
 * @property {unknown} [model]
 * @property {unknown} [pickedEffortModel]
 * @property {unknown} [finished]
 */

/** @typedef {{ path: string, mtimeMs: number, size: number }} TranscriptFile */
/** @typedef {{ mtimeMs: number, size: number, at: number }} TranscriptTime */

/** @typedef {{ checkedAt: number, key: string, metas: SubagentMeta[], paths: string[] }} DirCache */

/**
 * @typedef {object} SubagentCache
 * @property {Map<string, string>} projectDirs
 * @property {number} projectDirsAt
 * @property {Map<string, DirCache>} dirs
 * @property {Map<string, { mtimeMs: number, raw: RawMeta | null }>} metas
 * @property {Map<string, TranscriptTime>} transcripts
 * @property {number} failed
 */

const RESCAN_MS = 20_000

/** @returns {SubagentCache} */
export function createSubagentCache() {
  return { projectDirs: new Map(), projectDirsAt: 0, dirs: new Map(), metas: new Map(), transcripts: new Map(), failed: 0 }
}

/**
 * @param {string} cwd
 * @returns {string}
 */
function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
}

/**
 * The `~/.claude/projects` folder name for a working folder, from a listing refreshed each minute.
 * @param {Host} $
 * @param {SubagentCache} cache
 * @param {string} projectsDir
 * @param {string} cwd
 * @param {number} now
 * @returns {Promise<string | null>}
 */
export async function projectDirFor($, cache, projectsDir, cwd, now) {
  if (now - cache.projectDirsAt > 60_000) {
    cache.projectDirs.clear()
    try {
      for (const entry of await $.fs.list(projectsDir)) {
        if (entry.kind === 'dir') cache.projectDirs.set(entry.name.toLowerCase(), entry.name)
      }
    } catch {
      return null
    }
    cache.projectDirsAt = now
  }
  return cache.projectDirs.get(projectSlug(cwd)) ?? null
}

/**
 * @param {string} id
 * @param {RawMeta} raw
 * @param {number} lastActivityAt
 * @returns {SubagentMeta}
 */
function parseMeta(id, raw, lastActivityAt) {
  return {
    id,
    type: typeof raw.agentType === 'string' ? raw.agentType : 'agent',
    description: typeof raw.description === 'string' ? raw.description : '',
    model: typeof raw.pickedEffortModel === 'string' ? raw.pickedEffortModel : typeof raw.model === 'string' ? raw.model : null,
    finished: typeof raw.finished === 'boolean' ? raw.finished : null,
    lastActivityAt,
  }
}

/**
 * When a subagent last did something. Resuming a session rewrites all of its
 * subagent transcripts at once, so a write time alone makes long-finished
 * subagents look current. A transcript seen for the first time is read (up
 * to 4 MiB) for its last conversation entry; after that, only growth counts
 * as activity and a write that adds nothing keeps the time already known.
 * @param {Host} $
 * @param {SubagentCache} cache
 * @param {TranscriptFile} file
 * @returns {Promise<number>}
 */
export async function transcriptActivity($, cache, file) {
  const seen = cache.transcripts.get(file.path)
  if (seen && seen.mtimeMs === file.mtimeMs && seen.size === file.size) return seen.at
  let at = file.mtimeMs
  if (seen && file.size <= seen.size) at = seen.at
  else if (!seen && file.size <= TRANSCRIPT_MAX_BYTES) {
    try {
      at = lastEntryAt(await $.fs.read(file.path)) ?? file.mtimeMs
    } catch {
      cache.failed += 1
    }
  }
  cache.transcripts.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, at })
  return at
}

/**
 * The subagents a session's CLI transcript folder records (their small
 * `.meta.json` sidecars, plus each transcript's last entry time, see
 * `transcriptActivity`). `changeKey`, the
 * session's last activity, lets a quiet session skip the listing.
 * @param {Host} $
 * @param {SubagentCache} cache
 * @param {string} sep
 * @param {string} projectsDir
 * @param {readonly string[]} cwds
 * @param {string} cliSessionId
 * @param {string} changeKey
 * @param {number} now
 * @returns {Promise<SubagentMeta[]>}
 */
export async function readSubagents($, cache, sep, projectsDir, cwds, cliSessionId, changeKey, now) {
  const cached = cache.dirs.get(cliSessionId)
  if (cached && cached.key === changeKey && now - cached.checkedAt < RESCAN_MS) return cached.metas
  if (cached && cached.key === changeKey && !cached.metas.some(m => m.finished === false)) return cached.metas

  /** @type {string | null} */
  let folder = null
  for (const cwd of cwds) {
    const dir = await projectDirFor($, cache, projectsDir, cwd, now)
    if (!dir) continue
    const candidate = joinWith(sep, projectsDir, dir, cliSessionId, 'subagents')
    if (await $.fs.exists(candidate)) {
      folder = candidate
      break
    }
  }
  if (!folder) {
    cache.dirs.set(cliSessionId, { checkedAt: now, key: changeKey, metas: [], paths: [] })
    return []
  }

  const entries = await $.fs.list(folder)
  /** @type {Map<string, TranscriptFile>} */
  const transcripts = new Map()
  for (const entry of entries) {
    const match = entry.name.match(/^agent-(.+)\.jsonl$/)
    if (match?.[1]) transcripts.set(match[1], { path: joinWith(sep, folder, entry.name), mtimeMs: entry.mtimeMs, size: entry.size })
  }
  /** @type {SubagentMeta[]} */
  const metas = []
  /** @type {string[]} */
  const paths = []
  for (const entry of entries) {
    const match = entry.name.match(/^agent-(.+)\.meta\.json$/)
    if (!match?.[1]) continue
    const path = joinWith(sep, folder, entry.name)
    paths.push(path)
    let meta = cache.metas.get(path)
    if (!meta || meta.mtimeMs !== entry.mtimeMs) {
      /** @type {RawMeta | null} */
      let raw = null
      try {
        raw = /** @type {RawMeta} */ (JSON.parse(await $.fs.read(path)))
      } catch {
        raw = null
        cache.failed += 1
      }
      meta = { mtimeMs: entry.mtimeMs, raw }
      if (raw) cache.metas.set(path, meta)
      else cache.metas.delete(path)
    }
    if (!meta.raw) continue
    const transcript = transcripts.get(match[1])
    if (transcript) paths.push(transcript.path)
    metas.push(parseMeta(match[1], meta.raw, transcript ? await transcriptActivity($, cache, transcript) : entry.mtimeMs))
  }
  for (const old of cached?.paths ?? []) {
    if (paths.includes(old)) continue
    cache.metas.delete(old)
    cache.transcripts.delete(old)
  }
  cache.dirs.set(cliSessionId, { checkedAt: now, key: changeKey, metas, paths })
  return metas
}

/**
 * @param {SubagentCache} cache
 * @param {ReadonlySet<string>} keep
 * @returns {void}
 */
export function forgetSubagents(cache, keep) {
  for (const [key, dir] of [...cache.dirs]) {
    if (keep.has(key)) continue
    for (const path of dir.paths) {
      cache.metas.delete(path)
      cache.transcripts.delete(path)
    }
    cache.dirs.delete(key)
  }
}
