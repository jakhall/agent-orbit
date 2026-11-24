import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { isNonce, isProven, newNonce, proofOf } from '../../shared/proof.js'

const HOOK = fileURLToPath(new URL('../../hooks/approve.mjs', import.meta.url))
const TOKEN = 'c'.repeat(48)

/**
 * An Orbit stand-in that engages every request and answers allow at once,
 * proving the nonce as `proof` says: 'right', 'wrong' (another token) or
 * 'missing' (no header).
 */
async function fakeServer(proof) {
  const nonces = []
  let request = null
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      const nonce = String(req.headers['x-orbit-nonce'] ?? '')
      nonces.push(nonce)
      if (proof !== 'missing') res.setHeader('x-orbit-proof', createHmac('sha256', proof === 'wrong' ? 'f'.repeat(48) : TOKEN).update(nonce).digest('hex'))
      res.setHeader('content-type', 'application/json')
      if (req.method === 'POST' && req.url === '/api/hook/requests') {
        request = JSON.parse(body).request ?? null
        return res.end(JSON.stringify({ engaged: request !== null }))
      }
      if (req.method === 'GET' && request && req.url?.startsWith(`/api/hook/requests/${request.id}?`)) {
        return res.end(JSON.stringify({ status: 'answered', answer: { schema: 1, id: request.id, inputHash: request.inputHash, at: request.createdAt, behavior: 'allow' } }))
      }
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, nonces, port: server.address().port }
}

function runHook(data) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK, '--data', data, '--wait-ms', '5000'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.on('close', () => resolve(out))
    child.stdin.end(JSON.stringify({ session_id: '0a1b2c3d-0000-4000-8000-00000000ab01', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm spike.txt' } }))
  })
}

for (const [proof, isAllowed] of [['right', true], ['wrong', false], ['missing', false]]) {
  test(`the approval hook acts on an answer only when the server proves the token for its nonce (proof ${proof})`, async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-hook-proof-'))
    const fake = await fakeServer(proof)
    try {
      fs.writeFileSync(path.join(data, 'companion.json'), JSON.stringify({ port: fake.port, token: TOKEN, pid: process.pid }))
      const out = await runHook(data)
      assert.ok(fake.nonces.length > 0 && fake.nonces.every(isNonce), 'every call carries a fresh hex nonce')
      assert.equal(new Set(fake.nonces).size, fake.nonces.length, 'no nonce is reused')
      if (isAllowed) assert.equal(JSON.parse(out).hookSpecificOutput.decision.behavior, 'allow')
      else assert.equal(out, '', 'no output, so Claude shows its own dialog')
    } finally {
      fake.server.close()
      fs.rmSync(data, { recursive: true, force: true })
    }
  })
}

test('the shared proof matches HMAC-SHA256 and is checked in full', async () => {
  const nonce = newNonce()
  assert.equal(isNonce(nonce), true)
  assert.equal(nonce.length, 32)
  const want = createHmac('sha256', TOKEN).update(nonce).digest('hex')
  assert.equal(await proofOf(TOKEN, nonce), want)
  const longKey = 'k'.repeat(100)
  assert.equal(await proofOf(longKey, nonce), createHmac('sha256', longKey).update(nonce).digest('hex'), 'a key longer than a block is hashed first')
  assert.equal(await isProven(TOKEN, nonce, want), true)
  for (const bad of [undefined, '', want.slice(1), want.slice(0, -1) + (want.endsWith('0') ? '1' : '0'), createHmac('sha256', 'other').update(nonce).digest('hex')]) {
    assert.equal(await isProven(TOKEN, nonce, bad), false, String(bad))
  }
  assert.equal(isNonce('abc'), false)
  assert.equal(isNonce('z'.repeat(32)), false)
})
