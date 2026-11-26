import path from 'node:path'

import { isApprovalId } from '../../../shared/approvals.js'
import { send, readBody } from '../http.mjs'
import { commandStore, modPending, replyQueue, queueReply, replyResult, requestStop, sessionCommands, setReplyWait, stopQueue, stopResult, withdrawReply } from '../reply-api.mjs'
import { LONG_POLL_MS } from '../requests.mjs'
import { DATA, log, writeAtomic } from '../runtime.mjs'

export async function remoteRoutes(c, req, res, url, route) {
  const { s, audit, arm, notices, liveWindows, requests, broadcast } = c
  if (req.method === 'GET' && route === '/api/mod/notices') return send(res, 200, { notices: notices.pendingFor({ hasWindow: liveWindows.size > 0 }) })
  const noticeRoute = /^\/api\/mod\/notices\/([0-9a-z]{1,40})\/(claim|ack)$/.exec(route)
  if (noticeRoute && req.method === 'POST') {
    const body = await readBody(req)
    if (noticeRoute[2] === 'claim') return send(res, 200, notices.claim(noticeRoute[1], body.cli))
    const reason = ['disabled', 'no-channel', 'no-surface', 'refused', 'threw'].includes(body.reason) ? body.reason : null
    s.lastNoticeAck = { isSent: body.isSent === true, reason, at: Date.now() }
    log(`notice ${noticeRoute[1]} ${body.isSent === true ? 'raised' : `not raised${reason ? ` (${reason})` : ''}`}`)
    return send(res, 200, { ok: true })
  }
  const modRoute = /^\/api\/mod\/replies\/([0-9a-f-]{36})(?:\/(claim|ack|hold))?$/i.exec(route)
  if (modRoute && req.method === 'GET' && !modRoute[2]) return send(res, 200, modPending(modRoute[1]))
  if (modRoute && req.method === 'POST' && modRoute[2] === 'claim') {
    const body = await readBody(req)
    return send(res, 200, replyQueue.claim(modRoute[1], body.cli))
  }
  if (modRoute && req.method === 'POST' && modRoute[2] === 'hold') {
    const body = await readBody(req)
    return send(res, 200, replyQueue.hold(modRoute[1], body.cli))
  }
  if (modRoute && req.method === 'POST' && modRoute[2] === 'ack') {
    const body = await readBody(req)
    return replyQueue.ack(modRoute[1], body.cli, body.ack) ? send(res, 200, { ok: true }) : send(res, 400, { error: 'not an acknowledgement for this session' })
  }
  const modCommands = /^\/api\/mod\/commands\/([0-9a-f-]{36})$/i.exec(route)
  if (modCommands && req.method === 'POST') {
    const body = await readBody(req)
    return commandStore?.set(modCommands[1], body) ? send(res, 200, { ok: true }) : send(res, 400, { error: 'not a command list' })
  }
  if (req.method === 'GET' && route === '/api/commands') {
    const result = await sessionCommands(url.searchParams.get('sessionKey'))
    return send(res, result.status, result.body)
  }
  if (req.method === 'GET' && route === '/api/commands/catalog') return send(res, 200, { commands: commandStore?.catalog() ?? [] })
  const modStop = /^\/api\/mod\/stops\/([0-9a-f-]{36})\/(claim|ack)$/i.exec(route)
  if (modStop && req.method === 'POST') {
    const body = await readBody(req)
    if (!stopQueue) return send(res, 404, { error: 'not found' })
    if (modStop[2] === 'claim') return send(res, 200, stopQueue.claim(modStop[1], body.cli))
    return stopQueue.ack(modStop[1], body.cli, body.outcome) ? send(res, 200, { ok: true }) : send(res, 400, { error: 'not an acknowledgement for this session' })
  }
  if (req.method === 'POST' && route === '/api/mod/questions') {
    const result = requests.hold(await readBody(req))
    return send(res, result.status, result.body)
  }
  if (req.method === 'POST' && route === '/api/hook/requests') {
    if (Date.now() - s.hookSeenWrittenAt > 60_000) {
      s.hookSeenWrittenAt = Date.now()
      writeAtomic(path.join(DATA, 'hook.json'), JSON.stringify({ lastSeenAt: s.hookSeenWrittenAt }))
    }
    const result = requests.register(await readBody(req))
    return send(res, result.status, result.body)
  }
  const hookRoute = /^\/api\/hook\/requests\/([0-9a-f-]{36})(\/end)?$/.exec(route)
  if (hookRoute && req.method === 'GET' && !hookRoute[2]) {
    const result = await requests.wait(hookRoute[1], url.searchParams.get('nonce'), Number(url.searchParams.get('waitMs')) || LONG_POLL_MS)
    return send(res, result.status, result.body)
  }
  if (hookRoute && req.method === 'POST' && hookRoute[2]) {
    const body = await readBody(req)
    const result = requests.end(hookRoute[1], body.nonce, body.outcome)
    return send(res, result.status, result.body)
  }
  if (req.method === 'GET' && route === '/api/approvals') {
    return send(res, 200, { approvals: requests.list(), enabled: arm.isArmed('approvals'), stamp: `r${requests.stamp()}a${s.armVersion}` })
  }
  if (req.method === 'POST' && route === '/api/approvals/enabled') {
    const body = await readBody(req)
    if (typeof body?.enabled !== 'boolean') return send(res, 400, { error: 'enabled must be true or false' })
    arm.set('approvals', body.enabled)
    arm.set('questions', body.enabled)
    s.armVersion += 1
    audit.record({ kind: 'arm', capability: 'approvals', armed: body.enabled })
    audit.record({ kind: 'arm', capability: 'questions', armed: body.enabled })
    log(`approvals and questions from Orbit ${body.enabled ? 'armed' : 'disarmed'}`)
    broadcast()
    return send(res, 200, { ok: true, enabled: body.enabled })
  }
  const typingRoute = /^\/api\/approvals\/([0-9a-f-]{36})\/typing$/.exec(route)
  if (typingRoute && req.method === 'POST') {
    const result = requests.extend(typingRoute[1])
    return send(res, result.status, result.body)
  }
  const approvalRoute = /^\/api\/approvals\/([^/]+)$/.exec(route)
  if (approvalRoute && req.method === 'POST') {
    if (!isApprovalId(approvalRoute[1])) return send(res, 404, { error: 'not found' })
    const body = await readBody(req)
    if (body?.behavior === 'dismiss' && !arm.isArmed('replies')) return send(res, 403, { error: 'Replies as me are off, so a message cannot dismiss a question.' })
    const result = requests.answer(approvalRoute[1], body)
    return send(res, result.status, result.body)
  }
  if (req.method === 'POST' && route === '/api/reply') {
    const result = await queueReply(await readBody(req))
    return send(res, result.status, result.body)
  }
  if (req.method === 'POST' && route === '/api/stop') {
    const result = await requestStop(await readBody(req))
    return send(res, result.status, result.body)
  }
  const stopRoute = /^\/api\/stop\/([0-9a-f-]{36})$/i.exec(route)
  if (stopRoute && req.method === 'GET') {
    const result = stopResult(stopRoute[1])
    return send(res, result.status, result.body)
  }
  const replyRoute = /^\/api\/reply\/([0-9a-f-]{36})(?:\/(withdraw|wait))?$/i.exec(route)
  if (replyRoute && req.method === 'GET' && !replyRoute[2]) {
    const result = replyResult(replyRoute[1])
    return send(res, result.status, result.body)
  }
  if (replyRoute && req.method === 'POST' && replyRoute[2] === 'wait') {
    const result = setReplyWait(replyRoute[1], await readBody(req))
    return send(res, result.status, result.body)
  }
  if (replyRoute && req.method === 'POST' && replyRoute[2] === 'withdraw') {
    const result = await withdrawReply(replyRoute[1])
    return send(res, result.status, result.body)
  }
}
