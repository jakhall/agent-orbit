// @ts-check
import { normalizePath } from './path-utils.js'

/**
 * Places a session should not be grouped under when its edits name a real
 * repository: the profile itself, `~/.claude`, install folders, Windows, a
 * drive root (G-17).
 * @param {string} path
 * @param {string} home
 * @returns {boolean}
 */
export function isWeakRoot(path, home) {
  const p = normalizePath(path)
  const h = normalizePath(home)
  const inside = (/** @type {string} */ folder) => p === folder || p.startsWith(`${folder}\\`)
  if (/^[a-z]:$/.test(p)) return true
  if (h && (p === h || inside(`${h}\\.claude`) || inside(`${h}\\appdata\\local\\programs`) || inside(`${h}\\appdata\\roaming\\claude`))) return true
  return /^[a-z]:\\(program files( \(x86\))?|programdata|windows)(\\|$)/.test(p)
}

/**
 * How many edited files fall in each repository.
 * @param {Iterable<string>} paths
 * @param {(path: string) => string | null} rootOf the repository holding a path, or null
 * @returns {Map<string, number>}
 */
export function rootCounts(paths, rootOf) {
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const path of paths) {
    const root = rootOf(path)
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1)
  }
  return counts
}

/**
 * The repository a checkout belongs to (2.1): a linked worktree's `.git` is a
 * file pointing into `<repository>\.git\worktrees\<name>`; a main checkout
 * (a `.git` folder) or a submodule is its own.
 * @param {string} checkout
 * @param {string | null} dotGit the text of `<checkout>\.git` when it is a file, else null
 * @returns {string}
 */
export function repositoryOfCheckout(checkout, dotGit) {
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(dotGit ?? '')?.[1]
  if (!pointer) return checkout
  const target = pointer.replace(/\//g, '\\')
  const isAbsolute = /^[a-z]:\\/i.test(target) || target.startsWith('\\\\')
  /** @type {string[]} */
  const parts = []
  for (const part of (isAbsolute ? target : `${checkout.replace(/\//g, '\\')}\\${target}`).split('\\')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }
  const repository = /^(.*)\\\.git\\worktrees\\[^\\]+$/i.exec(parts.join('\\'))?.[1]
  return repository ?? checkout
}

/**
 * Which project a session belongs to (G-17): the person's override; else the
 * repository most of its edits land in, unless that is where it started or a
 * weak place; else where it started. Edits in several checkouts of one
 * repository count for that repository (2.1), and the busiest checkout is the
 * session's worktree. Ties go to the start, then by name, so the answer is stable.
 * @param {{ startRoot: string, editRoots: ReadonlyMap<string, number>, override: string | null, home: string, repositoryOf?: (checkout: string) => string }} input
 * @returns {{ root: string, source: 'edits' | 'folder' | 'override', worktree: string | null }}
 */
export function attributeProject({ startRoot, editRoots, override, home, repositoryOf = checkout => checkout }) {
  if (override) return { root: override, source: 'override', worktree: null }
  const start = normalizePath(repositoryOf(startRoot))
  /** @type {Map<string, { root: string, count: number, checkout: string, top: number }>} */
  const byRepository = new Map()
  for (const [checkout, count] of editRoots) {
    if (isWeakRoot(checkout, home)) continue
    const root = repositoryOf(checkout)
    const entry = byRepository.get(normalizePath(root)) ?? { root, count: 0, checkout, top: 0 }
    entry.count += count
    if (count > entry.top || (count === entry.top && normalizePath(checkout).localeCompare(normalizePath(entry.checkout)) < 0)) {
      entry.checkout = checkout
      entry.top = count
    }
    byRepository.set(normalizePath(root), entry)
  }
  const ranked = [...byRepository].sort((a, b) => b[1].count - a[1].count || Number(b[0] === start) - Number(a[0] === start) || a[0].localeCompare(b[0]))
  const best = ranked[0]
  if (!best || best[0] === start) return { root: startRoot, source: 'folder', worktree: null }
  const startCount = byRepository.get(start)?.count ?? 0
  if (startCount >= best[1].count && !isWeakRoot(startRoot, home)) return { root: startRoot, source: 'folder', worktree: null }
  return { root: best[1].root, source: 'edits', worktree: best[1].checkout }
}

/**
 * Whether a folder is a checkout of a project's repository (2.1.5): the
 * repository itself, a folder inside it (`.claude\worktrees\<name>`), or a
 * linked worktree whose `.git` points back to it. Never a weak place, so
 * `~\.claude` or an install folder is never shown as a project's worktree.
 * Without `repositoryOf` an outside folder is kept unless it is weak.
 * @param {{ checkout: string, root: string, home: string, repositoryOf?: (checkout: string) => string }} input
 * @returns {boolean}
 */
export function isCheckoutOf({ checkout, root, home, repositoryOf }) {
  const c = normalizePath(checkout)
  const r = normalizePath(root)
  if (c === r) return true
  if (isWeakRoot(checkout, home)) return false
  if (c.startsWith(`${r}\\`)) return true
  return repositoryOf ? normalizePath(repositoryOf(checkout)) === r : true
}
