import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { changeRows, outsideGroups, parseNumstatZ, parsePorcelainV2Z, pathKey } from '../../shared/changes.js'
import { transcriptName } from '../../shared/conversation.js'
import { normalizeFolder } from '../../shared/links.js'
import { canReuseChanges } from './changes-cache.mjs'
import { errorWhere } from './log.mjs'
import { SYSTEM32, log, isFolder, isFile, readText, toolEnv, readSnapshotForApi } from './runtime.mjs'
import { sessionEdits } from './transcripts.mjs'

const TOOL_PATHS = {
  git: () => process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe'),
  gh: () => process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'GitHub CLI', 'gh.exe'),
}
const toolExes = new Map()

export function sessionFoldersOf(snapshot) {
  return (Array.isArray(snapshot?.sessions) ? snapshot.sessions : []).map(s => s?.cwd).filter(c => typeof c === 'string')
}

export async function findToolExe(name, sessionFolders) {
  if (toolExes.has(name)) return toolExes.get(name)
  const preferred = TOOL_PATHS[name]()
  let found = preferred && (await isFile(preferred)) ? preferred : null
  if (!found) {
    const listed = await new Promise(resolve =>
      execFile(path.join(SYSTEM32, 'where.exe'), [`$PATH:${name}.exe`], { cwd: SYSTEM32, windowsHide: true, timeout: 4_000 }, (error, stdout) => resolve(error ? '' : String(stdout))),
    )
    const folders = sessionFolders.map(pathKey)
    found =
      listed
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => /^[A-Za-z]:\\/.test(line) && line.toLowerCase().endsWith(`\\${name}.exe`) && !folders.some(f => pathKey(line).startsWith(`${f}\\`))) ?? null
  }
  if (found) toolExes.set(name, found)
  return found
}

const GIT_BASE_ARGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false']
const GIT_TIMEOUT_MS = 4_000
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const GIT_PARALLEL = 2
let gitRunning = 0
const gitQueue = []

function gitSlot() {
  return new Promise(resolve => {
    if (gitRunning < GIT_PARALLEL) {
      gitRunning += 1
      resolve(undefined)
    } else gitQueue.push(resolve)
  })
}

function releaseGitSlot() {
  const next = gitQueue.shift()
  if (next) next(undefined)
  else gitRunning -= 1
}

function killTree(child) {
  if (!child.pid) return child.kill()
  execFile(path.join(SYSTEM32, 'taskkill.exe'), ['/T', '/F', '/PID', String(child.pid)], { cwd: SYSTEM32, windowsHide: true }, () => {})
}

export let gitRuns = 0

async function runGit(exe, cwd, args, overrides = []) {
  gitRuns += 1
  await gitSlot()
  try {
    return await new Promise(resolve => {
      let isTimedOut = false
      let timer = null
      const child = execFile(
        exe,
        [...GIT_BASE_ARGS, ...overrides, ...args],
        { cwd, windowsHide: true, maxBuffer: GIT_MAX_BUFFER, env: toolEnv({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_NO_LAZY_FETCH: '1' }) },
        (error, stdout, stderr) => {
          clearTimeout(timer)
          resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: error?.code ?? 0, isTimedOut })
        },
      )
      timer = setTimeout(() => {
        isTimedOut = true
        killTree(child)
      }, GIT_TIMEOUT_MS)
    })
  } finally {
    releaseGitSlot()
  }
}

async function localFilterOverrides(exe, root) {
  const listed = await runGit(exe, root, ['config', '--show-scope', '--name-only', '--get-regexp', '^filter\\.'])
  if (!listed.ok) return []
  const names = new Set()
  for (const line of listed.stdout.split(/\r?\n/)) {
    const match = /^(local|worktree|command)\s+filter\.(.+)\.[A-Za-z]+$/.exec(line)
    if (match?.[2]) names.add(match[2])
  }
  return [...names].flatMap(name => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`])
}

async function isLocalGitDir(folder) {
  for (let dir = folder; ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git')
    let stat = null
    try {
      stat = await fs.promises.stat(dotGit)
    } catch {}
    if (stat) {
      let gitDir = dotGit
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec((await readText(dotGit)) ?? '')?.[1]?.trim()
        gitDir = pointer ? path.resolve(dir, pointer) : dotGit
        if (!normalizeFolder(gitDir)) return false
      }
      const common = (await readText(path.join(gitDir, 'commondir')))?.trim()
      const commonDir = common ? path.resolve(gitDir, common) : gitDir
      if (!normalizeFolder(commonDir)) return false
      const alternates = (await readText(path.join(commonDir, 'objects', 'info', 'alternates'))) ?? ''
      for (const line of alternates.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))) {
        if (!normalizeFolder(path.resolve(commonDir, 'objects', line))) return false
      }
      return true
    }
    if (path.dirname(dir) === dir) return true
  }
}

const EMPTY_TREE = { sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' }

function gitState(answer) {
  if (answer.isTimedOut) return 'timeout'
  if (answer.code === 'ENOENT') return 'no-git'
  if (/dubious ownership|safe\.directory/i.test(answer.stderr)) return 'unsafe'
  if (/not a git repository/i.test(answer.stderr)) return 'not-repo'
  return 'error'
}

function outsidePlaces(snapshot) {
  const checkouts = [
    ...(Array.isArray(snapshot?.worktrees) ? snapshot.worktrees.map(w => w?.path) : []),
    ...(Array.isArray(snapshot?.projects) ? snapshot.projects.map(p => p?.root) : []),
    ...sessionFoldersOf(snapshot),
  ].filter(p => typeof p === 'string')
  return { home: process.env.USERPROFILE ?? '', temp: process.env.TEMP ?? process.env.TMP ?? '', checkouts }
}

const gitRootCache = new Map()
const GIT_ROOT_PATHS = 200

async function checkoutRootsOf(paths) {
  const roots = new Set()
  for (const file of paths.slice(0, GIT_ROOT_PATHS)) {
    let dir = normalizeFolder(path.dirname(file))
    for (let depth = 0; dir && depth < 12; depth += 1) {
      if (!gitRootCache.has(dir)) {
        gitRootCache.set(dir, await fs.promises.stat(path.join(dir, '.git')).then(() => true, () => false))
        if (gitRootCache.size > 2_000) gitRootCache.delete(gitRootCache.keys().next().value)
      }
      if (gitRootCache.get(dir)) {
        roots.add(dir)
        break
      }
      const parent = path.dirname(dir)
      dir = parent === dir ? null : parent
    }
  }
  return [...roots]
}

async function checkoutChanges(session, snapshot) {
  const places = outsidePlaces(snapshot)
  const empty = state => ({ state, branch: null, hasHead: false, upstream: null, files: [], moreFiles: 0, totals: { files: 0, added: 0, removed: 0 }, untracked: { count: 0, names: [] }, outside: outsideGroups([], places), edits: { count: 0, isPartial: false, isCut: false }, checkedAt: Date.now() })
  const folder = typeof session.cwd === 'string' ? normalizeFolder(session.cwd) : null
  if (!folder || !(await isFolder(folder))) return empty('missing')
  const name = transcriptName(snapshot, session.key)
  const editsRead = (name ? sessionEdits(name) : Promise.resolve({ paths: [], isPartial: false, isCut: false })).catch(() => ({ paths: [], isPartial: true, isCut: false }))
  const git = await gitChanges(folder, sessionFoldersOf(snapshot))
  const edits = await editsRead
  places.checkouts.push(...(await checkoutRootsOf(edits.paths)))
  const editCount = { count: edits.paths.length, isPartial: edits.isPartial, isCut: edits.isCut }
  if (git.state !== 'ok') return { ...empty(git.state), outside: outsideGroups(edits.paths, places), edits: editCount }
  const rows = changeRows({ root: git.root, status: git.status, numstat: git.numstat, edits: edits.paths, places })
  return { state: 'ok', branch: git.branch, hasHead: git.hasHead, upstream: git.upstream, ...rows, edits: editCount, checkedAt: Date.now() }
}

async function gitChanges(folder, sessionFolders) {
  const exe = await findToolExe('git', sessionFolders)
  if (!exe) return { state: 'no-git' }
  if (!(await isLocalGitDir(folder))) return { state: 'network' }
  const top = await runGit(exe, folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-object-format'])
  if (!top.ok) return { state: gitState(top) }
  const [topLevel = '', gitDir = '', commonDir = '', format = ''] = top.stdout.split(/\r?\n/).map(l => l.trim())
  const root = normalizeFolder(topLevel)
  if (!root || !(await isFolder(root))) return { state: 'error' }
  if (!normalizeFolder(path.resolve(gitDir)) || !normalizeFolder(path.resolve(folder, commonDir))) return { state: 'network' }
  const overrides = await localFilterOverrides(exe, root)
  const status = await runGit(exe, root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal', '--ignore-submodules=all'], overrides)
  if (!status.ok) return { state: gitState(status) }
  const parsed = parsePorcelainV2Z(status.stdout)
  const base = parsed.hasHead ? 'HEAD' : (EMPTY_TREE[format] ?? EMPTY_TREE.sha1)
  const numstat = await runGit(exe, root, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', base], overrides)
  return {
    state: 'ok',
    root,
    hasHead: parsed.hasHead,
    branch: parsed.branch,
    upstream: parsed.upstream,
    status: parsed.status,
    numstat: numstat.ok ? parseNumstatZ(numstat.stdout) : [],
  }
}

const changesCache = new Map()

export async function changes(key, wantsFresh) {
  const read = await readSnapshotForApi()
  if (read.error) return read.error
  const sessions = Array.isArray(read.snapshot?.sessions) ? read.snapshot.sessions : []
  const session = sessions.find(s => s && s.key === key)
  if (!session) return { status: 404, body: { error: 'This session is no longer in Orbit.' } }
  const cached = changesCache.get(key)
  const isReused = canReuseChanges(cached, session, Date.now(), wantsFresh)
  const view = isReused ? cached.view : checkoutChanges(session, read.snapshot)
  if (!isReused) {
    const entry = { at: Date.now(), cwd: session.cwd, view, state: null }
    changesCache.set(key, entry)
    void view.then(answer => (entry.state = answer?.state ?? null), () => undefined)
    while (changesCache.size > 50) changesCache.delete(changesCache.keys().next().value)
  }
  try {
    return { status: 200, body: await view }
  } catch (error) {
    if (changesCache.get(key)?.view === view) changesCache.delete(key)
    log(`changes for a session failed: ${errorWhere(error)}`)
    return { status: 500, body: { error: 'Could not read the changes.' } }
  }
}
