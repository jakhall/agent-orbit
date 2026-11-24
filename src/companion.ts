import type { EngineInterface } from 'claude-code'

import { MOD_VERSION } from '../shared/constants.js'
import { isProven, newNonce, NONCE_HEADER, PROOF_HEADER } from '../shared/proof.js'
import { isOlderVersion } from '../shared/version.js'
import { errorText, joinWith, readJson, type Paths } from './paths'

type CompanionInfo = {
  port: number
  pid: number
  startedAt: number
  lastSeenAt: number
  clients: number
  version?: string
  prChecks?: { state: 'idle' | 'ok' | 'unavailable'; reason: string | null } | null
}

type ServerMode = '--launch' | '--prune' | '--clear' | '--version'

let nodeExe: Promise<string | undefined> | undefined
const SERVER_FRESH_MS = 30_000
export const DAEMON_RETRY_MS = 60_000

function findNode($: EngineInterface, paths: Paths): Promise<string | undefined> {
  nodeExe ??= $.process
    .run([joinWith('\\', paths.system32, 'where.exe'), '$PATH:node.exe'], { cwd: paths.system32 })
    .then(({ exitCode, stdout }) => (exitCode === 0 ? stdout.split(/\r?\n/).map(l => l.trim()).find(l => /^[A-Za-z]:\\.*\\node\.exe$/i.test(l)) : undefined))
    .catch(() => undefined)
  return nodeExe
}

/**
 * Whether a pop-out server is running: it rewrites `companion.json` every
 * 10 s whether or not a window is connected (one stat, no read).
 */
export async function serverLive($: EngineInterface, paths: Paths, now: number): Promise<boolean> {
  const stat = await $.fs.stat(paths.companion).catch(() => null)
  return stat !== null && now - stat.mtimeMs < SERVER_FRESH_MS
}

/** Whether a companion window is connected now (its server heartbeats `companion.json`). */
export async function companionActive($: EngineInterface, paths: Paths, now: number): Promise<CompanionInfo | null> {
  const info = await readJson<CompanionInfo>($, paths.companion)
  if (!info || typeof info.lastSeenAt !== 'number') return null
  return now - info.lastSeenAt < 30_000 && info.clients > 0 ? info : null
}

/**
 * Runs `companion/server.mjs` in one of its short modes and reads the JSON
 * line it prints last. `--launch` reuses a running server or starts a
 * detached one, which then opens an Edge app window on 127.0.0.1 unless
 * `--no-window` is passed; `--version` prints the on-disk server's version.
 */
export async function runServer($: EngineInterface, paths: Paths, mode: ServerMode, extra: string[] = []): Promise<{ ok: boolean; message: string; version?: string }> {
  const node = await findNode($, paths)
  if (!node) return { ok: false, message: 'Node.js was not found on PATH, so the pop-out window cannot start.' }
  try {
    const script = joinWith(paths.sep, paths.pluginRoot, 'companion', 'server.mjs')
    const argv = mode === '--version' ? [node, script, mode] : [node, script, mode, ...extra, '--data', paths.data]
    const { exitCode, stdout, stderr } = await $.process.run(argv, { cwd: paths.system32, timeoutMs: mode === '--launch' ? 20_000 : mode === '--version' ? 10_000 : 30_000 })
    const last = stdout.trim().split(/\r?\n/).at(-1) ?? ''
    let parsed: { ok?: boolean; message?: string; version?: unknown } = {}
    try {
      parsed = JSON.parse(last) as typeof parsed
    } catch {
      parsed = {}
    }
    const version = typeof parsed.version === 'string' ? parsed.version : undefined
    if (exitCode === 0 && parsed.ok) return { ok: true, message: parsed.message ?? '', version }
    return { ok: false, message: parsed.message ?? (stderr.trim() || `exited ${exitCode}`) }
  } catch (error) {
    return { ok: false, message: errorText(error) }
  }
}

const CAPABILITIES = ['approvals', 'questions', 'replies'] as const

/**
 * The capabilities armed on the running server (D-6), for the pane's
 * persistent indicator: asked with the control token; null when no server
 * answers.
 */
export async function readArmed($: EngineInterface, paths: Paths): Promise<string[] | null> {
  const info = await readJson<{ port?: unknown; token?: unknown }>($, paths.companion)
  if (!info || typeof info.port !== 'number' || typeof info.token !== 'string') return null
  try {
    const nonce = newNonce()
    const answer = await $.http.fetch(`http://127.0.0.1:${info.port}/api/arm`, { headers: { 'x-orbit-token': info.token, [NONCE_HEADER]: nonce } })
    if (!answer.ok || !(await isProven(info.token, nonce, answer.headers?.[PROOF_HEADER]))) return null
    const view = JSON.parse(answer.text) as Record<string, { armed?: unknown } | undefined>
    return CAPABILITIES.filter(c => view[c]?.armed === true)
  } catch {
    return null
  }
}

/** What one session remembers about starting the daemon: when it last tried and what the pane should say. */
export type DaemonStarter = { lastTryAt: number; isBusy: boolean; note: string | null }

export function createDaemonStarter(): DaemonStarter {
  return { lastTryAt: Number.NEGATIVE_INFINITY, isBusy: false, note: null }
}

/**
 * Keeps a server running with no window while this session wants Orbit
 * (docs/CONTRACT.md): nothing when a live server is this version or newer;
 * otherwise, at most once a minute, `--version` first, and `--launch
 * --no-window` only when the on-disk server is not older than this mod. An
 * older on-disk server (a rollback) would ignore `--no-window` and open a
 * window, so it is never started.
 */
export async function ensureDaemon(
  $: EngineInterface,
  paths: Paths,
  now: number,
  starter: DaemonStarter,
  modVersion: string = MOD_VERSION,
): Promise<'live' | 'waiting' | 'busy' | 'started' | 'failed' | 'older-on-disk'> {
  if (starter.isBusy) return 'busy'
  const info = (await serverLive($, paths, now)) ? await readJson<CompanionInfo>($, paths.companion) : null
  if (info && !isOlderVersion(info.version, modVersion)) {
    starter.note = null
    return 'live'
  }
  if (now - starter.lastTryAt < DAEMON_RETRY_MS) return 'waiting'
  starter.lastTryAt = now
  starter.isBusy = true
  try {
    const onDisk = await runServer($, paths, '--version')
    if (!onDisk.ok || isOlderVersion(onDisk.version, modVersion)) {
      starter.note = `The Orbit server on disk (${onDisk.version ?? 'an older version'}) is older than this session's Orbit ${modVersion}, so it was not started.`
      return 'older-on-disk'
    }
    const started = await runServer($, paths, '--launch', ['--no-window'])
    starter.note = started.ok ? null : `The Orbit server did not start: ${started.message}`
    return started.ok ? 'started' : 'failed'
  } finally {
    starter.isBusy = false
  }
}
