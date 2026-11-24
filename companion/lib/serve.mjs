import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { APPROVAL_ATTENTIVE_MS, isKnownSession, isQuestionRequest } from '../../shared/approvals.js'
import { MOD_VERSION } from '../../shared/constants.js'
import { transcriptName } from '../../shared/conversation.js'
import { isPlainId } from '../../shared/inbox.js'
import { sanitizePrefs } from '../../shared/prefs.js'
import { createAggregator, RUN_EVERY_MS, SETTLE_MS } from './aggregator.mjs'
import { createArm } from './arm.mjs'
import { createAudit, forgedKind } from './audit.mjs'
import { shouldCheckPrs, shouldIdleExit } from './daemon.mjs'
import { editRoots, ATTRIBUTE_EVERY_MS, repositoryOf, refreshEditRoots } from './edit-roots.mjs'
import { createTranscriptFollower } from './follower.mjs'
import { nodeHost } from './host.mjs'
import { createLatency } from './latency.mjs'
import { launches, deliverFirstPrompts } from './launches.mjs'
import { claimServerLock, releaseServerLock, handOver, openWindow } from './lifecycle.mjs'
import { errorWhere } from './log.mjs'
import { NOTICE_MODES, createNotices } from './notices.mjs'
import { PR_TICK_MS, prs, prAnswer, refreshPrs } from './pr-checks.mjs'
import { pruneInbox, PRUNE_EVERY_MS, FIRST_PRUNE_MS, pruneFiles, pruneApprovals } from './prune.mjs'
import { createCommandStore } from './commands.mjs'
import { createReplyQueue } from './replies.mjs'
import { bindReplies, logExpiredReplies, logExpiredStops } from './reply-api.mjs'
import { createStopQueue } from './stops.mjs'
import { createRequestStore } from './requests.mjs'
import { createRouter } from './router.mjs'
import { ROOT, SYSTEM32, opts, DATA, FILES, log, readJson, writeAtomic, isAlive, liveAggregator, readSnapshotForApi, setLiveAggregator, desktopRoot as desktopRootPath } from './runtime.mjs'
import { createSecrets } from './secrets.mjs'
import { findTranscript } from './transcripts.mjs'

const PREFERRED_PORT = 47821
const HEARTBEAT_MS = 10_000

let liveRequests = null

/**
 * Waiting markers and open requests by CLI session id, for `status` (A4,
 * E-06): a prompt is Needs you while the session has not moved since it.
 */
function pendingApprovals() {
  const out = new Map()
  if (!liveRequests) return out
  const activity = new Map((liveAggregator?.state.snapshot?.sessions ?? []).map(s => [s.cliSessionId, s.lastActivityAt ?? 0]))
  for (const [cli, list] of liveRequests.markers()) {
    if ((activity.get(cli) ?? 0) > (list[0]?.createdAt ?? 0) + 2_000) liveRequests.clearMarker(cli)
    else out.set(cli, list)
  }
  return out
}

function aggregatorPaths() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const scratch = name => path.join(DATA, 'dry-run-none', name)
  const projectsDir = !opts.dryRun || opts.isProjectsGiven ? opts.projects : scratch('projects')
  const desktopRoot = desktopRootPath()
  return {
    sep: path.sep,
    data: DATA,
    sessionsDir: FILES.sessions,
    inboxDir: FILES.inbox,
    snapshot: FILES.snapshot,
    leader: FILES.leader,
    prefs: FILES.prefs,
    companion: FILES.companion,
    desktopRoot,
    projectsDir,
    pluginRoot: ROOT,
    system32: SYSTEM32,
  }
}

export async function serve() {
  fs.mkdirSync(DATA, { recursive: true })
  const owner = claimServerLock()
  if (owner && (await handOver(owner))) return
  process.on('exit', releaseServerLock)
  process.chdir(DATA)
  const secrets = createSecrets()
  const auditFile = path.join(DATA, 'audit.jsonl')
  const audit = createAudit({
    append: text => fs.appendFileSync(auditFile, text),
    size: () => fs.statSync(auditFile, { throwIfNoEntry: false })?.size ?? 0,
    rotate: () => fs.renameSync(auditFile, path.join(DATA, 'audit.1.jsonl')),
    read: () =>
      [path.join(DATA, 'audit.1.jsonl'), auditFile].map(file => {
        try {
          return fs.readFileSync(file, 'utf8')
        } catch {
          return ''
        }
      }),
  })
  const alerts = []
  let alertVersion = 0
  let onAlert = () => undefined
  const raiseAlert = (where, what) => {
    alerts.push({ kind: what === 'tampered' ? 'tampered' : 'forged-file', where, what, at: Date.now() })
    while (alerts.length > 50) alerts.shift()
    alertVersion += 1
    audit.record({ kind: 'alert', where, what })
    log(`alert: ${what === 'tampered' ? `${where} failed its check` : `a ${what} file in ${where} that Orbit did not write was refused`}`)
    onAlert()
  }
  const arm = createArm({
    read: name => {
      try {
        return fs.readFileSync(path.join(DATA, name), 'utf8')
      } catch {
        return null
      }
    },
    write: (name, text) => writeAtomic(path.join(DATA, name), text),
    now: Date.now,
  })
  if (arm.tampered) raiseAlert('arm', 'tampered')
  for (const capability of arm.restored()) audit.record({ kind: 'arm', capability, armed: true, outcome: 'restored at start' })
  const s = { armVersion: 0, lastNoticeAck: null, hookSeenWrittenAt: 0, lastClientAt: 0, port: 0, message: '', windowStats: null, prsWantedUntil: 0 }
  const notices = createNotices()
  const notifyFile = path.join(DATA, 'notify.json')
  const notifyMode = () => {
    const mode = readJson(notifyFile)?.mode
    return NOTICE_MODES.includes(mode) ? mode : 'needs-you'
  }
  bindReplies(createReplyQueue({ isArmed: () => arm.isArmed('replies') }), arm, audit, createStopQueue(), createCommandStore())
  const startedAt = Date.now()
  const clients = new Set()
  let lastRecordChangeAt = 0
  let lastSeq = 0
  const latency = createLatency()
  const attention = new Map()
  const liveWindows = new Set()
  const windowStreams = new Map()
  const follower = createTranscriptFollower({
    resolve: async key => {
      const read = await readSnapshotForApi()
      const name = read.snapshot ? transcriptName(read.snapshot, key) : null
      return name ? findTranscript(name) : null
    },
    watch: (file, onChange) => {
      try {
        const watcher = fs.watch(file, () => onChange())
        watcher.on('error', () => watcher.close())
        return () => watcher.close()
      } catch (error) {
        log(`fs.watch on a followed transcript unavailable (${error.code ?? error.name})`)
        return () => undefined
      }
    },
    send: (windowId, key) => windowStreams.get(windowId)?.write(`event: conversation\ndata: ${JSON.stringify({ key })}\n\n`),
  })
  const attentiveAt = () => (clients.size > 0 && attention.size > 0 ? Math.max(...[...attention.values()].map(a => a.at)) : 0)
  const isAttentive = now =>
    [...attention].some(([windowId, a]) => (windowId === 'legacy' ? clients.size > 0 : liveWindows.has(windowId)) && now - a.at <= (a.focused === true ? 60_000 : a.focused === false ? 8_000 : APPROVAL_ATTENTIVE_MS))
  let onRequestsChanged = () => undefined
  const requests = createRequestStore({
    isEngaged: request => arm.isArmed(isQuestionRequest(request) ? 'questions' : 'approvals') && isAttentive(Date.now()) && isKnownSession(liveAggregator?.state.snapshot ?? null, request.cliSessionId),
    isHeldEngaged: request => arm.isArmed('questions') && isKnownSession(liveAggregator?.state.snapshot ?? null, request.cliSessionId),
    onChange: () => onRequestsChanged(),
    log,
    isHookAlive: pid => isAlive(pid),
    onFinish: (request, outcome) =>
      audit.record({ kind: isQuestionRequest(request) ? 'question' : 'approval', id: request.id, session: request.cliSessionId, tool: request.toolName, inputHash: request.inputHash, outcome }),
  })
  liveRequests = requests

  const heartbeat = () => {
    const info = { port: s.port, pid: process.pid, token: secrets.controlToken, ...(opts.dryRun ? { pageToken: secrets.pageToken } : {}), startedAt, lastSeenAt: clients.size > 0 ? Date.now() : s.lastClientAt, clients: clients.size, message: s.message, version: MOD_VERSION, window: s.windowStats, prChecks: { state: prs.checks.state, reason: prs.checks.reason }, attentiveAt: attentiveAt() }
    try {
      writeAtomic(FILES.companion, JSON.stringify(info))
    } catch (error) {
      log(`heartbeat write failed: ${error.message}`)
    }
  }

  const stamps = () => {
    const mtime = file => {
      try {
        return fs.statSync(file).mtimeMs
      } catch {
        return 0
      }
    }
    const aggregated = liveAggregator ? { seq: liveAggregator.state.seq, bootId: liveAggregator.state.bootId, checkedAt: liveAggregator.state.checkedAt } : {}
    return { snapshot: aggregated.seq ?? 0, seq: aggregated.seq ?? 0, bootId: aggregated.bootId ?? null, checkedAt: aggregated.checkedAt ?? 0, prefs: mtime(FILES.prefs), prs: prs.version, approvals: `r${requests.stamp()}`, arm: s.armVersion, alerts: alertVersion }
  }
  let last = stamps()
  const broadcast = () => {
    const now = stamps()
    if (JSON.stringify(now) === JSON.stringify(last)) return
    last = now
    for (const res of clients) res.write(`event: changed\ndata: ${JSON.stringify(now)}\n\n`)
  }
  let watchTimer = null
  let onPrefsChanged = () => undefined
  try {
    const watcher = fs.watch(DATA, (_event, name) => {
      if (name !== 'prefs.json') return
      clearTimeout(watchTimer)
      watchTimer = setTimeout(() => {
        broadcast()
        onPrefsChanged()
      }, 200)
    })
    watcher.on('error', error => {
      log(`fs.watch on the data folder failed (${error.code ?? error.message}); polling only`)
      watcher.close()
    })
  } catch (error) {
    log(`fs.watch unavailable (${error.message}); polling only`)
  }
  setInterval(broadcast, 5_000).unref()

  const aggregator = createAggregator({
    host: nodeHost(),
    paths: aggregatorPaths(),
    readPrefs: () => readJson(FILES.prefs),
    readApprovals: pendingApprovals,
    readPrStatuses: () => prAnswer().statuses,
    write: async text => writeAtomic(FILES.snapshotV2, text),
    serverVersion: MOD_VERSION,
    readAttribution: () => ({ editRoots, repositoryOf, home: process.env.USERPROFILE ?? process.env.HOME ?? '' }),
    onRun: state => {
      if (state.seq !== lastSeq) {
        for (const notice of notices.observe(state.snapshot, { mode: notifyMode(), isAttentive: isAttentive(Date.now()) })) {
          for (const res of windowStreams.values()) res.write(`event: notice\ndata: ${JSON.stringify(notice)}\n\n`)
        }
        lastSeq = state.seq
        lastRecordChangeAt = Date.now()
        if (state.lastChange?.seq === state.seq) latency.changed(state.seq, state.lastChange.eventAt, state.lastChange.at)
      }
      broadcast()
    },
  })
  setLiveAggregator(aggregator)
  let aggregateTimer = null
  const aggregateSoon = () => {
    aggregator.noteEvent(Date.now())
    clearTimeout(aggregateTimer)
    aggregateTimer = setTimeout(() => void aggregator.run(), SETTLE_MS)
  }
  const watchFolder = (dir, label, options = {}) => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const watcher = fs.watch(dir, options, () => aggregateSoon())
      watcher.on('error', error => {
        log(`fs.watch on ${label} failed (${error.code ?? error.name}); polling only`)
        aggregator.state.isWatching = false
        watcher.close()
      })
      return true
    } catch (error) {
      log(`fs.watch on ${label} unavailable (${error.code ?? error.name}); polling only`)
      return false
    }
  }
  onPrefsChanged = () => void aggregator.run()
  onAlert = () => broadcast()
  const refuseForged = () => {
    const sweep = (dir, where) => {
      let names = []
      try {
        names = fs.readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        const what = forgedKind(where, name)
        if (!what) continue
        try {
          fs.rmSync(path.join(dir, name), { force: true })
        } catch {}
        raiseAlert(where, what)
      }
    }
    sweep(FILES.approvals, 'approvals')
    let sessions = []
    try {
      sessions = fs.readdirSync(FILES.inbox, { withFileTypes: true }).filter(d => d.isDirectory() && isPlainId(d.name))
    } catch {}
    for (const folder of sessions) sweep(path.join(FILES.inbox, folder.name), 'inbox')
  }
  refuseForged()
  setInterval(refuseForged, 2_000).unref()
  try {
    fs.mkdirSync(FILES.inbox, { recursive: true })
    const inboxWatcher = fs.watch(FILES.inbox, { recursive: true }, () => refuseForged())
    inboxWatcher.on('error', () => inboxWatcher.close())
  } catch {}
  onRequestsChanged = () => {
    broadcast()
    aggregateSoon()
  }
  setInterval(() => requests.sweep({ isWindowGone: clients.size === 0 && Date.now() - s.lastClientAt > 5_000 }), 1_000).unref()
  aggregator.state.isWatching = watchFolder(FILES.sessions, 'session records')
  const desktopRoot = aggregatorPaths().desktopRoot
  if (desktopRoot && fs.existsSync(desktopRoot)) watchFolder(desktopRoot, 'desktop records', { recursive: true })
  void aggregator.run()
  setInterval(() => void aggregator.run(), RUN_EVERY_MS).unref()
  const attribute = async () => {
    const snapshot = aggregator.state.snapshot
    if (!snapshot) return
    try {
      if (await refreshEditRoots(snapshot)) void aggregator.run()
    } catch (error) {
      log(`project attribution failed: ${errorWhere(error)}`)
    }
  }
  setTimeout(() => void attribute(), 1_500).unref()
  setInterval(() => void attribute(), ATTRIBUTE_EVERY_MS).unref()
  const pruneSafely = () => {
    try {
      pruneFiles()
    } catch (error) {
      log(`prune failed: ${errorWhere(error)}`)
    }
  }
  setTimeout(() => {
    pruneSafely()
    setInterval(pruneSafely, PRUNE_EVERY_MS).unref()
  }, FIRST_PRUNE_MS).unref()
  let isRefreshingPrs = false
  const isPrDemand = () => Date.now() < s.prsWantedUntil || readJson(FILES.prefs)?.settings?.showPRs === true
  const isPrNeedOn = () => sanitizePrefs(readJson(FILES.prefs)).settings.prProblemsNeedYou
  const tickPrs = async () => {
    if (isRefreshingPrs) return
    const isNeedOn = isPrNeedOn()
    if (!shouldCheckPrs({ windows: clients.size, attentiveAgoMs: Date.now() - attentiveAt(), isShown: isPrDemand(), isNeedOn })) return
    isRefreshingPrs = true
    const before = prs.version
    try {
      await refreshPrs()
    } catch (error) {
      log(`PR refresh failed: ${errorWhere(error)}`)
    } finally {
      isRefreshingPrs = false
    }
    if (prs.version !== before) {
      broadcast()
      heartbeat()
      if (isNeedOn) aggregateSoon()
    }
  }
  setInterval(() => void tickPrs(), PR_TICK_MS).unref()
  pruneInbox(Date.now())
  setInterval(() => pruneInbox(Date.now()), 60_000).unref()
  setInterval(() => {
    logExpiredReplies(Date.now())
    logExpiredStops(Date.now())
  }, 5_000).unref()
  fs.mkdirSync(FILES.approvals, { recursive: true })
  pruneApprovals()
  setInterval(() => pruneApprovals(), 60_000).unref()
  setInterval(() => {
    if (launches.prompts.size > 0) deliverFirstPrompts()
  }, 1_000).unref()
  let approvalTimer = null
  try {
    const watcher = fs.watch(FILES.approvals, () => {
      clearTimeout(approvalTimer)
      approvalTimer = setTimeout(() => {
        broadcast()
        aggregateSoon()
      }, 100)
    })
    watcher.on('error', error => {
      log(`fs.watch on approvals failed (${error.code ?? error.message}); polling only`)
      watcher.close()
    })
  } catch (error) {
    log(`fs.watch on approvals unavailable (${error.message}); polling only`)
  }

  const shutdown = reason => {
    log(`shutting down: ${reason}`)
    for (const res of clients) res.end()
    try {
      const info = readJson(FILES.companion)
      if (info?.pid === process.pid) fs.rmSync(FILES.companion, { force: true })
    } catch {}
    server.close()
    setTimeout(() => process.exit(0), 200).unref()
  }

  setInterval(() => {
    heartbeat()
    if (shouldIdleExit({ now: Date.now(), clients: clients.size, lastClientAt: s.lastClientAt, lastRecordChangeAt, startedAt })) shutdown('idle: no window and no session change for 30 minutes')
  }, HEARTBEAT_MS)

  const c = { s, secrets, audit, alerts, raiseAlert, arm, notices, notifyFile, notifyMode, startedAt, clients, attention, liveWindows, windowStreams, follower, attentiveAt, requests, latency, aggregator, heartbeat, stamps, broadcast, tickPrs, shutdown }
  const server = http.createServer(createRouter(c))

  let isFallback = opts.dryRun
  server.on('error', error => {
    if (error.code === 'EADDRINUSE' && !isFallback) {
      isFallback = true
      log(`port ${PREFERRED_PORT} is taken; using a random one`)
      server.listen(0, '127.0.0.1')
      return
    }
    log(`server error: ${error.message}`)
    process.exit(1)
  })
  server.on('listening', () => {
    s.port = server.address().port
    log(`listening on 127.0.0.1:${s.port}`)
    if (opts.open && !opts.dryRun) s.message = openWindow(s.port, secrets.issueLaunchCode(Date.now())).message
    heartbeat()
  })
  server.listen(isFallback ? 0 : PREFERRED_PORT, '127.0.0.1')
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', error => {
    log(`uncaught error, stopping: ${errorWhere(error)} ${error?.code ?? ''}`.trim())
    shutdown('uncaught error')
  })
  process.on('unhandledRejection', error => log(`unhandled rejection: ${error?.name ?? 'Error'} ${error?.code ?? ''}`.trim()))
}
