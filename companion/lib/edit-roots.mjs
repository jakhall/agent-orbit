import fs from 'node:fs'
import path from 'node:path'

import { repositoryOfCheckout, rootCounts } from '../../shared/aggregate/attribution.js'
import { transcriptName } from '../../shared/conversation.js'
import { findTranscript, transcriptEdits } from './transcripts.mjs'

export const editRoots = new Map()
const repoRootCache = new Map()
const GIT_ROOT_CACHE_MAX = 5_000
export const ATTRIBUTE_EVERY_MS = 30_000
const ATTRIBUTE_BUDGET_MS = 400

/** The checkout holding a file (the nearest folder with a `.git`), or null; cached per folder, no git process. */
function repoRootOf(file) {
  let dir = path.dirname(file.replace(/^\/([a-z])\//i, (_, drive) => `${drive.toUpperCase()}:\\`).replace(/\//g, '\\'))
  const walked = []
  let root = null
  for (let depth = 0; depth < 40; depth += 1) {
    const key = dir.toLowerCase()
    if (repoRootCache.has(key)) {
      root = repoRootCache.get(key)
      break
    }
    walked.push(key)
    if (fs.existsSync(path.join(dir, '.git'))) {
      root = dir
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (repoRootCache.size > GIT_ROOT_CACHE_MAX) repoRootCache.clear()
  for (const key of walked) repoRootCache.set(key, root)
  return root
}

const repositoryCache = new Map()

/** The repository a checkout belongs to: reads its `.git` only when that is a file (a linked worktree); cached, no git process. */
export function repositoryOf(checkout) {
  const key = checkout.toLowerCase()
  if (repositoryCache.has(key)) return repositoryCache.get(key)
  let dotGit = null
  try {
    const file = path.join(checkout, '.git')
    if (fs.statSync(file).isFile()) dotGit = fs.readFileSync(file, 'utf8').slice(0, 4096)
  } catch {
    dotGit = null
  }
  if (repositoryCache.size > GIT_ROOT_CACHE_MAX) repositoryCache.clear()
  const repository = repositoryOfCheckout(checkout, dotGit)
  repositoryCache.set(key, repository)
  return repository
}

/**
 * Per session, how many of its edited files land in each checkout (G-17),
 * from the same transcript edit index Changes uses. Never logs paths.
 * Returns whether anything moved.
 */
export async function refreshEditRoots(snapshot) {
  const deadline = Date.now() + ATTRIBUTE_BUDGET_MS
  let isChanged = false
  const live = new Set(snapshot.sessions.map(s => s.key))
  for (const key of [...editRoots.keys()]) if (!live.has(key)) editRoots.delete(key)
  for (const session of snapshot.sessions) {
    if (Date.now() > deadline) break
    const name = transcriptName(snapshot, session.key)
    if (!name) continue
    const file = await findTranscript(name)
    if (!file) continue
    const edits = await transcriptEdits(file, Math.min(deadline, Date.now() + 100))
    if (!edits) continue
    const counts = rootCounts(edits.paths, repoRootOf)
    if (JSON.stringify([...(editRoots.get(session.key) ?? [])]) !== JSON.stringify([...counts])) {
      editRoots.set(session.key, counts)
      isChanged = true
    }
  }
  return isChanged
}
