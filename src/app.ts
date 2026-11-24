import { atom, read, update } from 'claude-code'
import type { EngineInterface, SessionStartInput, Timer } from 'claude-code'

import type { Diag, GraphNode, InboxStats, Prefs, Snapshot, SnapshotV2 } from '../types'
import { APP_NAME, MOD_VERSION } from '../shared/constants.js'
import { normalizeSnapshot, packedProjects } from '../shared/filters.js'
import { withGraph } from '../shared/view.js'
import { hash } from '../shared/format.js'
import { prChecksText } from '../shared/prs.js'
import { companionActive, createDaemonStarter, ensureDaemon, readArmed, runServer, serverLive } from './companion'
import { inboxSetActive, inboxStart, inboxStop } from './core/inbox'
import { defaultPrefs, readPrefsFile, sanitizePrefs, savePrefs } from './core/prefs'
import { errorText, joinWith, readJson, resolvePaths, type Paths } from './paths'
import { INITIAL_DIAG, INITIAL_UI, PANE, SHAPES } from './state'
import { isPublishing, pub, publishEnd, publishFlush, publishInbox, publishStart, recordError } from './telemetry/publisher'

const versionAtom = atom({ plugin: 'orbit', key: 'snapshotVersion' } as const, { at: 0, n: 0 }, { shape: SHAPES.snapshotVersion })
const prefsAtom = atom({ plugin: 'orbit', key: 'prefs' } as const, defaultPrefs(), { shape: SHAPES.prefs })
const uiAtom = atom({ plugin: 'orbit', key: 'ui' } as const, INITIAL_UI, { shape: SHAPES.ui })
const diagAtom = atom({ plugin: 'orbit', key: 'diag' } as const, INITIAL_DIAG, { shape: SHAPES.diag })

const IDLE_INTERVAL_MS = 30_000
const WATCHED_INTERVAL_MS = 1_000
const SERVER_CHECK_MS = 10_000
const RENDER_WATCH_MS = 60_000
const SNAPSHOT_SCHEMA = 2
const daemonStarter = createDaemonStarter()

type ViewBox = { x: number; y: number; w: number; h: number }

/**
 * What one session's copy of the mod keeps between hooks: the refresh loop,
 * the last snapshot read from the server's `snapshot-v2.json` and the live
 * diagnostics. The mod never aggregates (the server is the one aggregator).
 * A hot reload starts afresh.
 */
export type AppState = {
  paths: Paths | null
  me: string
  entrypoint: string | null
  isDesktop: boolean
  lastFit: ViewBox | null
  lastNodes: GraphNode[]
  lastSvgChars: number
  renders: number
  renderMsTotal: number
  renderMsMax: number
  lastRenderMs: number
  timer: Timer | null
  isTicking: boolean
  lastRenderAt: number
  lastTickAt: number
  tickPhases: Record<string, number>
  lastSnapshotMtime: number
  lastPrefsMtime: number
  lastServerCheckAt: number
  companionText: string | null
  armed: string[] | null
  snapshotNotice: string | null
  snapshot: SnapshotV2 | null
  diag: Diag
}

export const app: AppState = {
  paths: null,
  me: '',
  entrypoint: null,
  isDesktop: false,
  lastFit: null,
  lastNodes: [],
  lastSvgChars: 0,
  renders: 0,
  renderMsTotal: 0,
  renderMsMax: 0,
  lastRenderMs: 0,
  timer: null,
  isTicking: false,
  lastRenderAt: 0,
  lastTickAt: 0,
  tickPhases: {},
  lastSnapshotMtime: 0,
  lastPrefsMtime: -1,
  lastServerCheckAt: Number.NEGATIVE_INFINITY,
  companionText: null,
  armed: null,
  snapshotNotice: null,
  snapshot: null,
  diag: { ...INITIAL_DIAG },
}

/**
 * Keeps the live diagnostics in memory and redraws only when something the
 * pane shows outside Diagnostics changed, or while Diagnostics is open.
 */
async function setDiag($: EngineInterface, patch: Partial<Diag>): Promise<void> {
  const before = app.diag
  app.diag = { ...before, ...patch }
  const isVisibleChange = before.role !== app.diag.role || before.lastError !== app.diag.lastError || before.companion !== app.diag.companion || before.notice !== app.diag.notice || String(before.armed) !== String(app.diag.armed)
  const isDiagOpen = (await read($, uiAtom)).view === 'diag'
  if (isVisibleChange || isDiagOpen) await update($, diagAtom, () => app.diag)
}

async function fail($: EngineInterface, error: unknown): Promise<void> {
  await recordError($, 'tick', error).catch(() => undefined)
  const message = errorText(error)
  $.ui.log(`orbit: ${message}`, { to: 'debug' })
  await setDiag($, { lastError: message })
}

function schedule($: EngineInterface, ms: number): void {
  app.timer?.cancel()
  app.timer = $.clock.after(ms, () => void tick($, false))
}

/**
 * Counts one pane render and how long it took, kept in memory and handed to
 * this session's record so the snapshot shows every pane's render cost.
 */
export function recordRender(ms: number, at: number): void {
  app.renders += 1
  app.lastRenderAt = at
  app.lastRenderMs = ms
  app.renderMsTotal += ms
  app.renderMsMax = Math.max(app.renderMsMax, ms)
  if (pub.record) {
    pub.record = {
      ...pub.record,
      pane: { renders: app.renders, lastMs: ms, avgMs: Math.round(app.renderMsTotal / app.renders), maxMs: app.renderMsMax, svgChars: app.lastSvgChars },
    }
  }
}

export async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: APP_NAME })
}

async function syncPrefs($: EngineInterface, force: boolean): Promise<Prefs> {
  if (!app.paths) return defaultPrefs()
  const stat = await $.fs.stat(app.paths.prefs).catch(() => null)
  const mtime = stat?.mtimeMs ?? 0
  if (!force && mtime === app.lastPrefsMtime) return read($, prefsAtom)
  const { prefs, isBroken } = await readPrefsFile($, app.paths.prefs, await read($, prefsAtom), await $.clock.now())
  if (isBroken) {
    await fail($, 'the preferences file could not be read; keeping the current preferences')
    return prefs
  }
  app.lastPrefsMtime = mtime
  await update($, prefsAtom, () => prefs)
  return prefs
}

/** Changes the shared prefs; resolves the save error, or null once written. */
export async function updatePrefs($: EngineInterface, change: (prefs: Prefs) => Prefs): Promise<string | null> {
  if (!app.paths) {
    await update($, prefsAtom, prefs => sanitizePrefs(change(prefs)))
    return null
  }
  const { prefs, error } = await savePrefs($, app.paths.prefs, change)
  const stat = await $.fs.stat(app.paths.prefs).catch(() => null)
  if (!error) app.lastPrefsMtime = stat?.mtimeMs ?? app.lastPrefsMtime
  await update($, prefsAtom, () => prefs)
  if (error) await fail($, `could not save preferences: ${error}`)
  return error
}

/**
 * Keeps this session's snapshot in module memory and bumps the small
 * version atom so panes redraw; the snapshot itself never crosses into
 * state (E-113).
 */
async function showSnapshot($: EngineInterface, snapshot: SnapshotV2 | null): Promise<void> {
  app.snapshot = snapshot
  await update($, versionAtom, v => ({ at: snapshot?.generatedAt ?? 0, n: v.n + 1 }))
}

/**
 * Reads the server's `snapshot-v2.json` when it changed. A file in a newer
 * format keeps the last good snapshot and says so (sessions do not
 * hot-reload, so an older session can meet a newer server).
 */
export async function readSnapshotFile($: EngineInterface): Promise<void> {
  if (!app.paths) return
  const stat = await $.fs.stat(app.paths.snapshotV2).catch(() => null)
  if (!stat || stat.mtimeMs === app.lastSnapshotMtime) return
  let text: string
  try {
    text = await $.fs.read(app.paths.snapshotV2)
  } catch (error) {
    app.lastSnapshotMtime = stat.mtimeMs
    await fail($, `could not read the server's snapshot (${Math.round(stat.size / 1024)} KB): ${errorText(error)}`)
    return
  }
  let raw: SnapshotV2 | null
  try {
    raw = JSON.parse(text) as SnapshotV2 | null
  } catch {
    return
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sessions)) return
  app.lastSnapshotMtime = stat.mtimeMs
  const schema = (raw as { schema?: unknown }).schema
  if (schema !== SNAPSHOT_SCHEMA) {
    app.snapshotNotice = typeof schema === 'number' && schema > SNAPSHOT_SCHEMA ? `Snapshot format ${schema} is newer than this session's Orbit ${MOD_VERSION}; start a new session to see live updates here.` : null
    return
  }
  app.snapshotNotice = null
  const parsed = normalizeSnapshot(raw)
  app.diag = { ...app.diag, snapshotBytes: text.length }
  await showSnapshot($, parsed)
}

export async function appStart($: EngineInterface, e: SessionStartInput): Promise<void> {
  app.paths = await resolvePaths($)
  app.entrypoint = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) ?? null
  app.isDesktop = app.entrypoint === 'claude-desktop'
  app.me = await $.session.id()
  if (app.isDesktop || e.isInteractive) {
    try {
      await publishStart($, app.paths, e.cwd, app.entrypoint)
    } catch (error) {
      await fail($, error)
    }
  }
  await syncPrefs($, true)
  await readSnapshotFile($)
  inboxStart($, app.paths, app.me, stats => void onInboxStats($, stats))
  schedule($, 400 + (hash(app.me) % 2_500))
}

async function onInboxStats($: EngineInterface, stats: InboxStats): Promise<void> {
  await setDiag($, { inbox: stats })
  await publishInbox($, stats)
}

async function restartPublisher($: EngineInterface): Promise<void> {
  if (!app.paths) return
  app.me = await $.session.id()
  const cwd = await $.session.cwd()
  inboxStart($, app.paths, app.me, stats => void onInboxStats($, stats))
  await publishStart($, app.paths, cwd, app.entrypoint)
}

/**
 * One refresh of this session's copy: prefs, then, while the pane is shown
 * (or on a manual tick), keeping the server running and reading its
 * snapshot. A pane drawn in the last minute polls every second (one stat);
 * the server and window checks run every 10 s.
 */
const laidOut: { key: string; view: Snapshot | null } = { key: '', view: null }

/**
 * The snapshot a pane draws: the server's schema 2 plus the graph laid out
 * with `shared/layout.js` for this reader's dragged positions (X-3), worked
 * out again only when the snapshot (`bootId`, `seq`) or the positions change.
 */
export function paneSnapshot(snapshot: SnapshotV2 | null, positions: Prefs['positions'], tier: 0 | 1 | 2 = 2, window?: { filters: Prefs['filters']; pinned: readonly string[]; now: number }): Snapshot | null {
  if (!snapshot) return null
  const pack = window ? packedProjects(snapshot, window.filters, window.now, window.pinned) : undefined
  const key = JSON.stringify([snapshot.bootId, snapshot.seq, snapshot.generatedAt, positions, tier, pack ? [...pack].sort() : null])
  if (key !== laidOut.key || !laidOut.view) {
    laidOut.key = key
    laidOut.view = withGraph(snapshot, positions, { tier, pack })
  }
  return laidOut.view
}

export async function tick($: EngineInterface, isManual: boolean): Promise<void> {
  if (!app.paths || app.isTicking) return
  app.isTicking = true
  let next = IDLE_INTERVAL_MS
  const started = Date.now()
  const phases: Record<string, number> = {}
  let mark = started
  const phase = (name: string) => {
    const at = Date.now()
    phases[name] = at - mark
    mark = at
  }
  try {
    const now = await $.clock.now()
    app.lastTickAt = now
    const paths = app.paths
    const prefs = await syncPrefs($, false)
    phase('prefs')
    if (prefs.settings.paused && !isManual) {
      await setDiag($, { role: 'idle', lastTickAt: now })
      return
    }
    const panes = await $.ui.panes().catch(() => [])
    const isShown = panes.some(p => p.id === PANE && p.isShown)
    if (!isShown && !isManual) {
      if (now - app.lastServerCheckAt >= SERVER_CHECK_MS) {
        app.lastServerCheckAt = now
        inboxSetActive($, await serverLive($, paths, now))
      }
      await setDiag($, { role: 'idle', lastTickAt: now, companion: null })
      return
    }
    if (isManual || now - app.lastServerCheckAt >= SERVER_CHECK_MS) {
      app.lastServerCheckAt = now
      inboxSetActive($, await serverLive($, paths, now))
      void ensureDaemon($, paths, now, daemonStarter).catch(error => recordError($, 'daemon', error))
      const companion = await companionActive($, paths, now)
      app.companionText = companion ? `port ${companion.port}, ${companion.clients} window(s)${companion.prChecks ? ` · ${prChecksText(companion.prChecks)}` : ''}` : null
      app.armed = (await serverLive($, paths, now)) ? await readArmed($, paths) : null
    }
    phase('server')
    await readSnapshotFile($)
    phase('read')
    if (now - app.lastRenderAt < RENDER_WATCH_MS) next = WATCHED_INTERVAL_MS
    app.tickPhases = phases
    const notice = app.snapshotNotice ?? daemonStarter.note
    await setDiag($, {
      role: 'reader',
      lastTickAt: now,
      lastTickMs: Date.now() - started,
      ticks: app.diag.ticks + 1,
      publishWrites: pub.writes,
      tickPhases: phases,
      companion: app.companionText ?? daemonStarter.note,
      armed: app.armed,
      errors: pub.errors,
      notice,
      lastError: pub.lastError ?? (app.snapshot === null ? notice : null),
    })
  } catch (error) {
    await fail($, error)
  } finally {
    app.isTicking = false
    schedule($, next)
  }
}

export async function popOut($: EngineInterface): Promise<{ ok: boolean; message: string }> {
  if (!app.paths) return { ok: false, message: 'The mod has not started in this session.' }
  const result = await runServer($, app.paths, '--launch')
  if (result.ok) schedule($, 1_500)
  return { ok: result.ok, message: result.message || 'Pop-out window opened.' }
}

export async function clearData($: EngineInterface): Promise<{ ok: boolean; message: string }> {
  if (!app.paths) return { ok: false, message: 'The mod has not started in this session.' }
  const result = await runServer($, app.paths, '--clear')
  app.lastSnapshotMtime = 0
  app.lastPrefsMtime = -1
  await showSnapshot($, null)
  await update($, uiAtom, () => INITIAL_UI)
  await syncPrefs($, true)
  if (isPublishing()) await publishFlush($)
  schedule($, 500)
  return result
}

export async function appEnd($: EngineInterface, reason: string): Promise<void> {
  try {
    await publishEnd($, reason)
  } catch (error) {
    pub.lastError = errorText(error)
  }
  if (reason === 'clear' || reason === 'resume') {
    $.clock.after(1_500, () => void restartPublisher($))
    return
  }
  app.timer?.cancel()
  app.timer = null
  inboxStop()
}
