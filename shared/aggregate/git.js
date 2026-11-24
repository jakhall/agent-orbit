// @ts-check

import { joinWith } from './path-utils.js'

/** @typedef {import('./path-utils.js').Host} Host */

const TTL_MS = 60_000
const MAX_AGE_MS = 5 * 60_000
const FORGET_AFTER_MS = 10 * 60_000

/** @typedef {Map<string, { at: number, branch: string | null }>} BranchCache */

/** @returns {BranchCache} */
export function createBranchCache() {
  return new Map()
}

/**
 * Drops branches not asked for in ten minutes (checkouts that went away).
 * @param {BranchCache} cache
 * @param {number} now
 * @returns {void}
 */
export function pruneBranchCache(cache, now) {
  for (const [root, entry] of cache) if (now - entry.at > FORGET_AFTER_MS) cache.delete(root)
}

/**
 * The branch checked out at `gitRoot`, read from HEAD (no git process): a
 * worktree's `.git` is a file naming its gitdir.
 * @param {Host} $
 * @param {BranchCache} cache
 * @param {string} sep
 * @param {string} gitRoot
 * @param {number} now
 * @param {{ left: number }} [budget] re-reads of cached checkouts this run may still spend: past 60 s an entry
 *   is read again only while the budget lasts, and always past 5 minutes, so the entries cached in one run do not
 *   all expire together (E-109)
 * @returns {Promise<string | null>}
 */
export async function branchOf($, cache, sep, gitRoot, now, budget = { left: Number.POSITIVE_INFINITY }) {
  const cached = cache.get(gitRoot)
  const age = cached ? now - cached.at : Number.POSITIVE_INFINITY
  if (cached && (age < TTL_MS || (age < MAX_AGE_MS && budget.left <= 0))) return cached.branch
  if (cached && age < MAX_AGE_MS) budget.left -= 1
  /** @type {string | null} */
  let branch = null
  try {
    const dotGit = joinWith(sep, gitRoot, '.git')
    const stat = await $.fs.stat(dotGit)
    let headPath = joinWith(sep, dotGit, 'HEAD')
    if (stat.kind === 'file') {
      const pointer = (await $.fs.read(dotGit)).match(/gitdir:\s*(.+)\s*$/m)?.[1]?.trim()
      if (pointer && !/^[\\/]{2}/.test(pointer)) {
        const isAbsolute = /^[A-Za-z]:[\\/]/.test(pointer)
        headPath = joinWith(sep, isAbsolute ? pointer : joinWith(sep, gitRoot, pointer), 'HEAD')
      }
    }
    const head = (await $.fs.read(headPath)).trim()
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1]
    branch = ref ?? (head.length >= 7 ? `detached ${head.slice(0, 7)}` : null)
  } catch {
    branch = null
  }
  cache.set(gitRoot, { at: now, branch })
  return branch
}
