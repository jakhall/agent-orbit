import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { MOD_VERSION } from '../../../shared/constants.js'
import { CAPABILITIES } from '../arm.mjs'
import { send, readBody } from '../http.mjs'
import { openWindow } from '../lifecycle.mjs'
import { errorWhere } from '../log.mjs'
import { NOTICE_MODES } from '../notices.mjs'
import { mergePrefs } from '../prefs-file.mjs'
import { clearData } from '../prune.mjs'
import { REPLY_PROTOCOL } from '../replies.mjs'
import { opts, DATA, FILES, log, readJson, writeAtomic } from '../runtime.mjs'
import { stateAnswer } from '../state.mjs'

export async function windowRoutes(c, req, res, url, route) {
  const { s, secrets, audit, alerts, arm, notices, notifyFile, notifyMode, startedAt, clients, attention, liveWindows, windowStreams, follower, attentiveAt, latency, aggregator, heartbeat, stamps, broadcast, tickPrs, shutdown } = c
  if (req.method === 'GET' && route === '/api/ping') return send(res, 200, { ok: true, pid: process.pid })
  if (req.method === 'GET' && route === '/api/health') {
    const a = aggregator.state
    return send(res, 200, {
      ok: a.errors.length === 0 && a.snapshot !== null,
      version: MOD_VERSION,
      pid: process.pid,
      bootId: a.bootId,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      aggregator: { seq: a.seq, checkedAt: a.checkedAt, lastRunAt: a.lastRunAt, lastMs: a.lastMs, phases: a.phases, isWatching: a.isWatching, isPaused: a.isPaused, lastEventAt: a.lastEventAt, errors: a.errors },
      sources: a.snapshot?.sources ?? null,
      windows: clients.size,
      attentiveAt: attentiveAt(),
      daemon: opts.daemon,
      latency: latency.summary(),
      arm: arm.view(),
      alerts: { count: alerts.length, latest: alerts.at(-1) ?? null },
      notices: { mode: notifyMode(), ...notices.stats(), lastDelivery: s.lastNoticeAck },
    })
  }
  if (req.method === 'GET' && route === '/api/state') {
    const files = { snapshot: ':memory:', prefs: FILES.prefs }
    const readText = file => (file === ':memory:' ? Promise.resolve(aggregator.state.snapshot ? JSON.stringify(aggregator.state.snapshot) : 'null') : fs.promises.readFile(file, 'utf8'))
    const body = await stateAnswer({ readText, takeStamps: stamps, files, wantsSnapshot: url.searchParams.get('parts') !== 'prefs' })
    return send(res, 200, body)
  }
  if (req.method === 'GET' && route === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    const windowId = randomBytes(8).toString('hex')
    res.write(`event: hello\ndata: ${JSON.stringify({ ...stamps(), windowId })}\n\n`)
    clients.add(res)
    liveWindows.add(windowId)
    windowStreams.set(windowId, res)
    s.lastClientAt = Date.now()
    heartbeat()
    void tickPrs()
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    req.on('close', () => {
      clearInterval(ping)
      clients.delete(res)
      liveWindows.delete(windowId)
      windowStreams.delete(windowId)
      follower.stop(windowId)
      attention.delete(windowId)
      s.lastClientAt = Date.now()
      heartbeat()
    })
    return true
  }
  if (req.method === 'GET' && route === '/api/notify') return send(res, 200, { mode: notifyMode(), modes: NOTICE_MODES })
  if (req.method === 'POST' && route === '/api/notify') {
    const body = await readBody(req)
    if (!NOTICE_MODES.includes(body.mode)) return send(res, 400, { error: `mode is one of ${NOTICE_MODES.join(', ')}` })
    writeAtomic(notifyFile, JSON.stringify({ mode: body.mode, at: Date.now() }))
    log(`notifications: ${body.mode}`)
    return send(res, 200, { ok: true, mode: body.mode })
  }
  const noticeRoute = /^\/api\/notices\/([0-9a-z]{1,40})\/(claim|ack)$/.exec(route)
  if (noticeRoute && req.method === 'POST') {
    const body = await readBody(req)
    if (typeof body.windowId !== 'string' || !liveWindows.has(body.windowId)) return send(res, 400, { error: 'windowId is an open window' })
    if (noticeRoute[2] === 'claim') return send(res, 200, notices.claim(noticeRoute[1], `window:${body.windowId}`))
    const shownAs = ['system', 'banner'].includes(body.shownAs) ? body.shownAs : null
    s.lastNoticeAck = { isSent: shownAs !== null, reason: shownAs ? null : 'not-shown', shownAs, at: Date.now() }
    log(`notice ${noticeRoute[1]} ${shownAs ? `shown in a window (${shownAs})` : 'not shown in a window'}`)
    return send(res, 200, { ok: true })
  }
  if (req.method === 'POST' && route === '/api/attention') {
    const body = await readBody(req)
    const windowId = typeof body.windowId === 'string' && liveWindows.has(body.windowId) ? body.windowId : 'legacy'
    if (Object.hasOwn(body, 'selected')) {
      const selected = body.selected
      if (selected !== null && (typeof selected !== 'string' || selected === '' || selected.length > 600)) return send(res, 400, { error: 'selected is a session key or null' })
      if (windowId !== 'legacy') void follower.follow(windowId, selected).catch(error => log(`follow failed: ${errorWhere(error)}`))
    }
    if (body.attentive === true) attention.set(windowId, { at: Date.now(), focused: typeof body.focused === 'boolean' ? body.focused : undefined })
    else attention.delete(windowId)
    heartbeat()
    return send(res, 200, { ok: true })
  }
  if (req.method === 'POST' && route === '/api/prefs') {
    const body = await readBody(req)
    const prefs = mergePrefs(body ?? {})
    return send(res, 200, { ok: true, prefs })
  }
  if (req.method === 'POST' && route === '/api/stats') {
    const body = await readBody(req)
    const n = v => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0)
    s.windowStats = { renders: n(body.renders), avgMs: n(body.avgMs), maxMs: n(body.maxMs), at: Date.now() }
    const painted = body.painted
    if (painted && typeof painted === 'object' && Number.isSafeInteger(painted.seq) && Number.isFinite(painted.at) && painted.bootId === aggregator.state.bootId) latency.painted(painted.seq, Math.min(painted.at, Date.now()))
    return send(res, 200, { ok: true })
  }
  if (req.method === 'POST' && route === '/api/window') {
    if (opts.dryRun) return send(res, 200, { ok: true, message: 'dry run: no window opened', launchPath: `/inbox?launch=${secrets.issueLaunchCode(Date.now())}` })
    const opened = openWindow(s.port, secrets.issueLaunchCode(Date.now()))
    s.message = opened.message
    return send(res, opened.isOpened ? 200 : 503, { ok: opened.isOpened, message: opened.message, ...(opened.isOpened ? {} : { error: opened.message, reason: 'no-edge' }) })
  }
  if (req.method === 'GET' && route === '/api/alerts') return send(res, 200, { alerts: [...alerts].reverse() })
  if (req.method === 'GET' && route === '/api/audit') {
    const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '200', 10) || 200))
    return send(res, 200, { entries: audit.recent(limit) })
  }
  if (req.method === 'GET' && route === '/api/arm') {
    const sessions = aggregator.state.snapshot?.sessions ?? []
    const hookSeenAt = readJson(path.join(DATA, 'hook.json'))?.lastSeenAt
    const setup = {
      hookSeenAt: Number.isFinite(hookSeenAt) ? hookSeenAt : null,
      replySessions: sessions.filter(s => s.publisher?.replyProtocol === REPLY_PROTOCOL && s.publisher.endedAt === null).length,
      olderSessions: sessions.filter(s => s.publisher && s.publisher.endedAt === null && s.publisher.replyProtocol !== REPLY_PROTOCOL).length,
    }
    return send(res, 200, { ...arm.view(), tampered: arm.tampered, setup })
  }
  if (req.method === 'POST' && route === '/api/arm') {
    const body = await readBody(req)
    if (!CAPABILITIES.includes(body.capability) || typeof body.armed !== 'boolean') return send(res, 400, { error: `capability is one of ${CAPABILITIES.join(', ')} and armed is true or false` })
    const view = arm.set(body.capability, body.armed)
    s.armVersion += 1
    audit.record({ kind: 'arm', capability: body.capability, armed: body.armed })
    log(`${body.capability} ${body.armed ? 'armed' : 'disarmed'} from a window`)
    broadcast()
    return send(res, 200, { ok: true, arm: view })
  }
  if (req.method === 'POST' && route === '/api/clear') {
    const removed = clearData([FILES.snapshot, FILES.snapshotV2, FILES.leader], { keepFolders: true })
    log(`cleared from a window: ${removed.length} items`)
    void aggregator.run()
    return send(res, 200, { ok: true, removed })
  }
  if (req.method === 'POST' && route === '/api/shutdown') {
    send(res, 200, { ok: true })
    shutdown('asked to stop')
    return true
  }
}
