// @ts-check

export const CHANGE_FILES = 200
export const CHANGE_UNTRACKED = 20
const OUTSIDE_GROUPS = 8
const OUTSIDE_PATHS = 10
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const AGENT_FOLDERS = ['.claude\\projects', '.claude\\plans', '.claude\\todos', '.claude\\tasks', '.claude\\shell-snapshots', 'appdata\\local\\temp']

/**
 * @typedef {object} StatusEntry
 * @property {string} code the two status letters (`XY`), `??` for untracked
 * @property {string} path
 * @property {string | null} oldPath a rename's or copy's source
 */

/**
 * @typedef {object} NumstatEntry
 * @property {string} path
 * @property {string | null} oldPath
 * @property {number | null} added null for a binary file
 * @property {number | null} removed
 */

/**
 * @typedef {object} ChangeRow
 * @property {string} path relative to the checkout, `/`-separated
 * @property {string | null} oldPath
 * @property {string} status one letter: M, A, D, R, C, T or U
 * @property {number | null} added
 * @property {number | null} removed
 * @property {boolean} isBinary
 * @property {boolean} isEdited this session's transcript edits it
 */

/**
 * @typedef {object} OutsideView files a session edited outside the checkout
 * @property {number} count
 * @property {number} scratch agent working files (temp folders, `~\.claude` session memory, plans, tasks), counted only
 * @property {{ label: string, root: string, count: number, paths: string[] }[]} groups the rest by checkout (or folder), paths relative to `root`, at most 10 each
 * @property {number} moreGroups
 */

/**
 * @typedef {object} ChangesView
 * @property {'ok' | 'not-repo' | 'unsafe' | 'network' | 'no-git' | 'missing' | 'timeout' | 'error'} state
 * @property {string | null} branch
 * @property {boolean} hasHead false in a repository without a commit yet
 * @property {{ ahead: number, behind: number } | null} upstream null without one
 * @property {ChangeRow[]} files at most `CHANGE_FILES`, edited first
 * @property {number} moreFiles
 * @property {{ files: number, added: number, removed: number }} totals
 * @property {{ count: number, names: { path: string, isEdited: boolean }[] }} untracked
 * @property {OutsideView} outside
 * @property {{ count: number, isPartial: boolean, isCut: boolean }} edits `isPartial` while the transcript is still being read; `isCut` when only its last 64 MiB were
 * @property {number} checkedAt
 */

/**
 * `git diff --numstat -z` output as entries: `added<TAB>removed<TAB>path`
 * per NUL, or for a rename an empty path followed by source and destination
 * fields. Binary files report `-` counts (null here).
 * @param {string} text
 * @returns {NumstatEntry[]}
 */
export function parseNumstatZ(text) {
  const fields = text.split('\0')
  /** @type {NumstatEntry[]} */
  const out = []
  for (let i = 0; i < fields.length; i += 1) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(fields[i] ?? '')
    if (!match) continue
    const count = (/** @type {string} */ v) => (v === '-' ? null : Number(v))
    if (match[3] === '') {
      const oldPath = fields[i + 1] ?? ''
      const path = fields[i + 2] ?? ''
      i += 2
      if (path) out.push({ path, oldPath, added: count(match[1] ?? '-'), removed: count(match[2] ?? '-') })
    } else out.push({ path: match[3] ?? '', oldPath: null, added: count(match[1] ?? '-'), removed: count(match[2] ?? '-') })
  }
  return out
}

/**
 * The files one transcript line (JSONL) edits: `file_path` / `notebook_path`
 * of its Edit, Write, MultiEdit and NotebookEdit tool calls. Main-session and
 * sidechain lines alike; anything else, or a line that does not parse, gives none.
 * @param {string} line
 * @returns {string[]}
 */
export function editedPathsOf(line) {
  if (!line.includes('"tool_use"')) return []
  /** @type {any} */
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return []
  }
  const content = entry?.type === 'assistant' ? entry.message?.content : null
  if (!Array.isArray(content)) return []
  /** @type {string[]} */
  const out = []
  for (const block of content) {
    if (block?.type !== 'tool_use' || !EDIT_TOOLS.includes(block.name)) continue
    const input = block.input && typeof block.input === 'object' ? block.input : {}
    const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
    if (file && file.length <= 1000) out.push(file)
  }
  return out
}

/**
 * A Windows path in one comparable form: backslashes, no trailing separator,
 * lower case (`/c/x` from a POSIX shell becomes `c:\x`).
 * @param {string} path
 * @returns {string}
 */
export function pathKey(path) {
  const windows = path.replace(/^\/([a-zA-Z])\//, '$1:/').replace(/\//g, '\\')
  return windows.replace(/\\+$/, '').toLowerCase()
}

/**
 * The checkout's changes as rows for the pop-out: tracked changes versus
 * HEAD with their line counts, untracked files, and which files this
 * session's transcript edited (marked and listed first; those outside the
 * checkout in their own short list). Paths compare case-insensitively.
 * @param {{ root: string, status: StatusEntry[], numstat: NumstatEntry[], edits: readonly string[], places?: OutsidePlaces }} input
 * @returns {Pick<ChangesView, 'files' | 'moreFiles' | 'totals' | 'untracked' | 'outside'>}
 */
export function changeRows(input) {
  const rootKey = pathKey(input.root)
  /** @type {Set<string>} */
  const editedInside = new Set()
  /** @type {Map<string, string>} */
  const outside = new Map()
  for (const file of input.edits) {
    const key = pathKey(file)
    if (key.startsWith(`${rootKey}\\`)) editedInside.add(key.slice(rootKey.length + 1).replace(/\\/g, '/'))
    else if (!outside.has(key)) outside.set(key, file)
  }
  const isEdited = (/** @type {string} */ path) => {
    const key = path.toLowerCase()
    return key.endsWith('/') ? [...editedInside].some(e => e.startsWith(key)) : editedInside.has(key)
  }
  const statusOf = new Map(input.status.filter(s => s.code !== '??').map(s => [s.path.toLowerCase(), s.code]))
  const letter = (/** @type {string} */ path) => {
    const code = statusOf.get(path.toLowerCase()) ?? ''
    const pick = code.includes('U') || code === 'AA' || code === 'DD' ? 'U' : code.includes('D') ? 'D' : code.replace(/[ ?!]/g, '').charAt(0)
    return pick || 'M'
  }
  /** @type {ChangeRow[]} */
  const rows = input.numstat.map(n => ({
    path: n.path,
    oldPath: n.oldPath,
    status: n.oldPath ? 'R' : letter(n.path),
    added: n.added,
    removed: n.removed,
    isBinary: n.added === null,
    isEdited: isEdited(n.path),
  }))
  const listed = new Set(rows.map(r => r.path.toLowerCase()))
  for (const s of input.status) {
    if (s.code === '??' || s.code === '!!' || listed.has(s.path.toLowerCase())) continue
    listed.add(s.path.toLowerCase())
    rows.push({ path: s.path, oldPath: s.oldPath, status: letter(s.path), added: null, removed: null, isBinary: false, isEdited: isEdited(s.path) })
  }
  const byEditedThenPath = (/** @type {{ path: string, isEdited: boolean }} */ a, /** @type {{ path: string, isEdited: boolean }} */ b) =>
    Number(b.isEdited) - Number(a.isEdited) || a.path.localeCompare(b.path)
  rows.sort(byEditedThenPath)
  const untracked = input.status
    .filter(s => s.code === '??')
    .map(s => ({ path: s.path, isEdited: isEdited(s.path) }))
    .sort(byEditedThenPath)
  return {
    files: rows.slice(0, CHANGE_FILES),
    moreFiles: Math.max(0, rows.length - CHANGE_FILES),
    totals: {
      files: rows.length,
      added: rows.reduce((sum, r) => sum + (r.added ?? 0), 0),
      removed: rows.reduce((sum, r) => sum + (r.removed ?? 0), 0),
    },
    untracked: { count: untracked.length, names: untracked.slice(0, CHANGE_UNTRACKED) },
    outside: outsideGroups([...outside.values()], input.places ?? { home: '', temp: '', checkouts: [] }),
  }
}

/**
 * @typedef {object} OutsidePlaces
 * @property {string} home the user's profile folder
 * @property {string} temp the temp folder
 * @property {readonly string[]} checkouts known checkout roots (from the snapshot)
 */

/**
 * Edits outside the checkout, sorted for reading: agent working files (temp
 * folders, `~\.claude` session memory, plans, tasks) only counted; the rest
 * grouped by the known checkout holding them, else by folder, largest first.
 * @param {readonly string[]} paths absolute
 * @param {OutsidePlaces} places
 * @returns {OutsideView}
 */
export function outsideGroups(paths, places) {
  const home = pathKey(places.home)
  const scratchRoots = [pathKey(places.temp), ...(home ? AGENT_FOLDERS.map(f => `${home}\\${f}`) : [])].filter(Boolean)
  const roots = [...new Set(places.checkouts.map(pathKey).filter(Boolean))].sort((a, b) => b.length - a.length)
  /** @type {Map<string, { label: string, root: string, files: string[] }>} */
  const groups = new Map()
  let scratch = 0
  for (const file of paths) {
    const key = pathKey(file)
    if (scratchRoots.some(r => key.startsWith(`${r}\\`))) {
      scratch += 1
      continue
    }
    const windows = file.replace(/\//g, '\\')
    const checkout = roots.find(r => key.startsWith(`${r}\\`))
    const cut = checkout ? checkout.length : Math.max(0, windows.lastIndexOf('\\'))
    const root = windows.slice(0, cut)
    const group = groups.get(root.toLowerCase()) ?? { label: root.split('\\').filter(Boolean).at(-1) ?? root, root, files: [] }
    group.files.push(windows.slice(cut).replace(/^\\+/, ''))
    groups.set(root.toLowerCase(), group)
  }
  const sorted = [...groups.values()].sort((a, b) => b.files.length - a.files.length || a.label.localeCompare(b.label))
  return {
    count: paths.length,
    scratch,
    groups: sorted.slice(0, OUTSIDE_GROUPS).map(g => ({ label: g.label, root: g.root, count: g.files.length, paths: g.files.sort((a, b) => a.localeCompare(b)).slice(0, OUTSIDE_PATHS) })),
    moreGroups: Math.max(0, sorted.length - OUTSIDE_GROUPS),
  }
}

/**
 * `git status --porcelain=v2 -z --branch` output: the branch headers
 * (`# branch.oid`, `.head`, `.ab`) and the entries, with v2's `.` for an
 * unchanged side turned back into v1's space so `changeRows` reads both
 * alike. A rename (`2`) is followed by its source as the next field;
 * ignored entries (`!`) are dropped.
 * @param {string} text
 * @returns {{ branch: string | null, hasHead: boolean, upstream: { ahead: number, behind: number } | null, status: StatusEntry[] }}
 */
export function parsePorcelainV2Z(text) {
  const fields = text.split('\0')
  /** @type {StatusEntry[]} */
  const status = []
  let branch = /** @type {string | null} */ (null)
  let hasHead = false
  let upstream = /** @type {{ ahead: number, behind: number } | null} */ (null)
  const code = (/** @type {string} */ xy) => xy.replace(/\./g, ' ')
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? ''
    if (field.startsWith('# branch.oid ')) hasHead = field.slice('# branch.oid '.length) !== '(initial)'
    else if (field.startsWith('# branch.head ')) {
      const head = field.slice('# branch.head '.length)
      branch = head === '(detached)' ? 'detached' : head.slice(0, 200) || null
    } else if (field.startsWith('# branch.ab ')) {
      const ab = /^\+(\d+) -(\d+)$/.exec(field.slice('# branch.ab '.length))
      upstream = ab ? { ahead: Number(ab[1]), behind: Number(ab[2]) } : null
    } else if (field.startsWith('1 ')) {
      const parts = field.split(' ')
      status.push({ code: code(parts[1] ?? '  '), path: parts.slice(8).join(' '), oldPath: null })
    } else if (field.startsWith('2 ')) {
      const parts = field.split(' ')
      status.push({ code: code(parts[1] ?? '  '), path: parts.slice(9).join(' '), oldPath: fields[i + 1] ?? null })
      i += 1
    } else if (field.startsWith('u ')) {
      const parts = field.split(' ')
      status.push({ code: code(parts[1] ?? '  '), path: parts.slice(10).join(' '), oldPath: null })
    } else if (field.startsWith('? ')) status.push({ code: '??', path: field.slice(2), oldPath: null })
  }
  return { branch, hasHead, upstream, status }
}
