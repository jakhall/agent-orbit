import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const MAX_STDIN = 4 * 1024 * 1024
const DRAIN_MS = 100
const STDIN_MS = 2_000
const REGISTER_MS = 1_500
const POLL_SLACK_MS = 5_000

function dataFolder() {
  const at = process.argv.indexOf('--data')
  if (at >= 0 && process.argv[at + 1]) return path.resolve(process.argv[at + 1])
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.claude', 'orbit')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readStdin(limitMs) {
  return new Promise(resolve => {
    const chunks = []
    let size = 0
    let isOver = false
    const done = text => {
      clearTimeout(timer)
      resolve(text)
    }
    const timer = setTimeout(() => done(null), limitMs)
    process.stdin.on('data', chunk => {
      size += chunk.length
      if (size > MAX_STDIN) isOver = true
      else chunks.push(chunk)
    })
    process.stdin.on('end', () => done(isOver ? null : Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => done(null))
  })
}

function finish(output) {
  if (output) process.stdout.write(output, () => process.exit(0))
  else process.exit(0)
}

function waitOverride(maxMs) {
  const at = process.argv.indexOf('--wait-ms')
  const ms = at >= 0 && process.argv.includes('--data') ? Number(process.argv[at + 1]) : NaN
  return Number.isInteger(ms) && ms > 0 && ms <= maxMs ? ms : undefined
}

/** One call to the local Orbit server with its control token; null on any failure. */
/**
 * True only when the server answered the nonce with HMAC-SHA256 under the
 * token from companion.json, so a listener that took over the port is refused.
 */
function isProven(token, nonce, proof) {
  if (typeof proof !== 'string') return false
  const want = Buffer.from(createHmac('sha256', token).update(nonce).digest('hex'))
  const given = Buffer.from(proof)
  return given.length === want.length && timingSafeEqual(given, want)
}

function call(server, method, route, body, timeoutMs) {
  return new Promise(resolve => {
    const text = body === undefined ? undefined : JSON.stringify(body)
    const nonce = randomBytes(16).toString('hex')
    const req = http.request(
      { host: '127.0.0.1', port: server.port, method, path: route, headers: { 'x-orbit-token': server.token, 'x-orbit-nonce': nonce, 'content-type': 'application/json', ...(text ? { 'content-length': Buffer.byteLength(text) } : {}) }, timeout: timeoutMs },
      res => {
        if (!isProven(server.token, nonce, res.headers['x-orbit-proof'])) {
          res.resume()
          return resolve(null)
        }
        let data = ''
        res.setEncoding('utf8')
        res.on('data', chunk => (data += chunk))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) })
          } catch {
            resolve(null)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    if (text) req.write(text)
    req.end()
  })
}

/**
 * The settings-level PermissionRequest hook (A5). It trusts no file: it
 * hands every prompt to the running Orbit server (a text-free wait marker
 * when it cannot be shown), and only when the server says Orbit engages
 * (capability armed, a window attentive, a known session) it waits for the
 * answer over a long poll with a nonce only it holds. No server, a refusal
 * or any error: no output, so Claude shows its own dialog.
 */
async function main() {
  const data = dataFolder()
  const info = readJson(path.join(data, 'companion.json'))
  if (!info || !Number.isInteger(info.port) || typeof info.token !== 'string' || !Number.isInteger(info.pid) || !isAlive(info.pid)) {
    await readStdin(DRAIN_MS)
    return finish(null)
  }
  const server = { port: info.port, token: info.token }
  const text = await readStdin(STDIN_MS)
  if (text === null) return finish(null)
  const input = JSON.parse(text)
  const toolName = typeof input?.tool_name === 'string' ? input.tool_name : ''
  if (!toolName || typeof input?.session_id !== 'string') return finish(null)
  const [{ createHash, randomUUID }, approvals] = await Promise.all([import('node:crypto'), import('../shared/approvals.js')])
  const { APPROVAL_WAIT_MS, QUESTION_WAIT_MAX_MS, approvalRequest, hashText, hookDecision, isPersonOnlyTool } = approvals
  const nonce = randomUUID()
  const marker = { marker: { cliSessionId: input.session_id.slice(0, 100), toolName: toolName.slice(0, 60) }, nonce }
  if (isPersonOnlyTool(toolName)) {
    await call(server, 'POST', '/api/hook/requests', marker, REGISTER_MS)
    return finish(null)
  }

  const waitMs = waitOverride(APPROVAL_WAIT_MS) ?? APPROVAL_WAIT_MS
  const inputHash = createHash('sha256').update(hashText(toolName, input.tool_input ?? null)).digest('hex')
  const id = randomUUID()
  let request = approvalRequest(input, { id, now: Date.now(), inputHash, hookPid: process.pid, waitMs, agentId: typeof input.agent_id === 'string' ? input.agent_id.slice(0, 100) : null })
  if (!request) {
    await call(server, 'POST', '/api/hook/requests', marker, REGISTER_MS)
    return finish(null)
  }
  const registered = await call(server, 'POST', '/api/hook/requests', { request, nonce }, REGISTER_MS)
  if (registered?.status !== 200 || registered.body?.engaged !== true) return finish(null)

  const end = outcome => call(server, 'POST', `/api/hook/requests/${id}/end`, { nonce, outcome }, REGISTER_MS)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => void end('stopped').then(() => finish(null)))
  const longest = request.createdAt + QUESTION_WAIT_MAX_MS
  let deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const left = deadline - Date.now()
    const answer = await call(server, 'GET', `/api/hook/requests/${id}?nonce=${nonce}&waitMs=${Math.max(0, left)}`, undefined, left + POLL_SLACK_MS)
    if (!answer || answer.status !== 200) return finish(null)
    if (answer.body?.status === 'answered') {
      const decision = hookDecision(answer.body.answer, request, Date.now())
      return finish(decision?.output ?? null)
    }
    if (Number.isFinite(answer.body?.expiresAt) && answer.body.expiresAt > request.expiresAt) {
      deadline = Math.min(longest, Math.max(deadline, answer.body.expiresAt))
      request = { ...request, expiresAt: Math.min(longest, answer.body.expiresAt) }
    }
  }
  await end('expired')
  return finish(null)
}

main().catch(() => finish(null))
