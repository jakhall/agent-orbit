import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchEnv } from '../../shared/launch.js'

export const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SELF = path.join(HERE, 'server.mjs')
export const ROOT = path.resolve(HERE, '..')
export const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const LOG_MAX = 200 * 1024

/**
 * The command line, read without side effects (E-33): the options, or why
 * they are refused. Defaults point at the person's own data folder.
 * @param {readonly string[]} argv the arguments after the script
 * @param {{ USERPROFILE?: string, HOME?: string }} env
 */
export function parseArgs(argv, env = process.env) {
  const out = { mode: '', data: '', projects: '', desktop: '', open: false, dryRun: false, noWindow: false, daemon: false, isProjectsGiven: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--launch' || a === '--serve' || a === '--prune' || a === '--clear' || a === '--version') out.mode = a.slice(2)
    else if (a === '--data') out.data = argv[++i] ?? ''
    else if (a === '--projects') out.projects = argv[++i] ?? ''
    else if (a === '--desktop') out.desktop = argv[++i] ?? ''
    else if (a === '--open') out.open = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--no-window') out.noWindow = true
    else if (a === '--daemon') out.daemon = true
  }
  if (out.dryRun && !out.data) return { ok: false, message: '--dry-run needs its own --data folder' }
  if ((out.projects || out.desktop) && !out.dryRun) return { ok: false, message: '--projects and --desktop are for tests and need --dry-run' }
  out.isProjectsGiven = out.projects !== ''
  const home = env.USERPROFILE ?? env.HOME ?? '.'
  if (!out.data) out.data = path.join(home, '.claude', 'orbit')
  if (!out.projects) out.projects = path.join(home, '.claude', 'projects')
  return { ok: true, opts: out }
}

export const IS_MAIN = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === SELF

function args() {
  if (!IS_MAIN) return { ...parseArgs([]).opts, data: path.join(os.tmpdir(), 'orbit-server-imported'), projects: path.join(os.tmpdir(), 'orbit-server-imported', 'projects') }
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.ok) return parsed.opts
  process.stdout.write(`${JSON.stringify({ ok: false, message: parsed.message })}\n`)
  process.exit(2)
}

export const opts = args()
export const DATA = opts.data
export const FILES = {
  companion: path.join(DATA, 'companion.json'),
  snapshot: path.join(DATA, 'snapshot.json'),
  leader: path.join(DATA, 'leader.json'),
  prefs: path.join(DATA, 'prefs.json'),
  log: path.join(DATA, 'companion.log'),
  actions: path.join(DATA, 'actions'),
  inbox: path.join(DATA, 'inbox'),
  approvals: path.join(DATA, 'approvals'),
  sessions: path.join(DATA, 'sessions'),
  profile: path.join(DATA, 'edge-profile'),
  lock: path.join(DATA, 'server.lock'),
  snapshotV2: path.join(DATA, 'snapshot-v2.json'),
}

export function log(line) {
  try {
    fs.mkdirSync(DATA, { recursive: true })
    const stat = fs.existsSync(FILES.log) ? fs.statSync(FILES.log) : null
    if (stat && stat.size > LOG_MAX) {
      const text = fs.readFileSync(FILES.log, 'utf8')
      fs.writeFileSync(FILES.log, text.slice(text.length - LOG_MAX / 2))
    }
    fs.appendFileSync(FILES.log, `${new Date().toISOString()} [${process.pid}] ${line}\n`)
  } catch {}
}

export function print(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export const pause = new Int32Array(new SharedArrayBuffer(4))

export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (error) {
      if (attempt < 4) Atomics.wait(pause, 0, 0, 25 * (attempt + 1))
      else {
        try {
          fs.unlinkSync(tmp)
        } catch {}
        throw error
      }
    }
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function isFolder(folder) {
  try {
    return (await fs.promises.stat(folder)).isDirectory()
  } catch {
    return false
  }
}

export async function isFile(file) {
  try {
    return (await fs.promises.stat(file)).isFile()
  } catch {
    return false
  }
}

export async function readText(file) {
  try {
    return await fs.promises.readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * The environment every child gets (E-43): the launch allow-list (system
 * paths, profile folders, temp, processor facts), never the launching
 * session's tokens or Claude variables.
 */
export function childEnv(extra = {}) {
  return { ...launchEnv(process.env).env, ...extra }
}

export function toolEnv(extra) {
  return childEnv(extra)
}

export let liveAggregator = null

export function setLiveAggregator(aggregator) {
  liveAggregator = aggregator
}

export async function readSnapshotForApi() {
  const snapshot = liveAggregator?.state.snapshot ?? null
  return snapshot ? { snapshot } : { error: { status: 503, body: { error: 'Orbit is still reading the sessions; try again.' } } }
}

export function desktopRoot() {
  return opts.dryRun ? opts.desktop || null : process.env.APPDATA ? path.join(process.env.APPDATA, 'Claude', 'claude-code-sessions') : null
}
