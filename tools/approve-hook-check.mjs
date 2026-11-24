import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ANSWER_WAIT_MS = 8_000
const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = path.join(HERE, '..', 'hooks', 'approve.mjs')
const SERVER = path.join(HERE, '..', 'companion', 'server.mjs')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-approve-'))
const approvals = path.join(scratch, 'approvals')
const desktop = path.join(scratch, 'desktop', 'acct', 'org')
fs.mkdirSync(desktop, { recursive: true })

const sample = (patch = {}) => ({
  session_id: '0a1b2c3d-0000-4000-8000-00000000ab01',
  transcript_path: 'C:\\x\\t.jsonl',
  cwd: 'C:\\repo\\app',
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'rm spike.txt', description: 'Remove the spike file' },
  ...patch,
})
fs.writeFileSync(path.join(desktop, 'local_0a1b2c3d-0000-4000-8000-00000000ab01.json'), JSON.stringify({ sessionId: 'local_0a1b2c3d-0000-4000-8000-00000000ab01', cliSessionId: sample().session_id, title: 'Hook check', lastActivityAt: Date.now() - 60_000 }))

const sleep = ms => new Promise(r => setTimeout(r, ms))
let server = null
let info = null
let stream = null

function api(method, route, body) {
  return new Promise(resolve => {
    const text = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: info.port, method, path: route, headers: { 'x-orbit-token': info.pageToken, 'content-type': 'application/json' } }, res => {
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }))
    })
    req.on('error', () => resolve({ status: 0, body: null }))
    if (text) req.write(text)
    req.end()
  })
}

async function startServer() {
  server = spawn(process.execPath, [SERVER, '--serve', '--dry-run', '--data', scratch, '--desktop', path.join(scratch, 'desktop'), '--projects', path.join(scratch, 'projects')], { stdio: 'ignore' })
  for (let i = 0; i < 100 && !info?.pageToken; i += 1) {
    await sleep(100)
    try {
      info = JSON.parse(fs.readFileSync(path.join(scratch, 'companion.json'), 'utf8'))
    } catch {}
  }
  for (let i = 0; i < 50; i += 1) {
    const state = await api('GET', '/api/state')
    if (state.body?.snapshot?.sessions?.some(s => s.cliSessionId === sample().session_id)) return
    await sleep(100)
  }
  throw new Error('the dry-run server did not show the sample session')
}

function openWindow() {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: info.port, path: `/api/events?t=${info.pageToken}` }, res => res.once('data', () => resolve(res)))
    req.end()
  })
}

/** Answers the next request the window lists, as the page would; `forge` writes an answer file instead. */
function answerNext(answer, { forge = false, onRequest = null } = {}) {
  let isStopped = false
  void (async () => {
    while (!isStopped) {
      const listed = await api('GET', '/api/approvals')
      const request = listed.body?.approvals?.find(a => a.answered === null)
      if (request) {
        onRequest?.(request)
        if (forge) fs.writeFileSync(path.join(approvals, `${request.id}.answer.json`), JSON.stringify({ schema: 1, id: request.id, inputHash: request.inputHash, at: Date.now(), ...answer(request) }))
        else if (answer) await api('POST', `/api/approvals/${request.id}`, { inputHash: request.inputHash, ...answer(request) })
        return
      }
      await sleep(30)
    }
  })()
  return () => (isStopped = true)
}

function runHook(stdin, { answer = null, forge = false, waitMs = answer ? ANSWER_WAIT_MS : 2_000, onRequest = null } = {}) {
  return new Promise(resolve => {
    const started = process.hrtime.bigint()
    const child = spawn(process.execPath, [HOOK, '--data', scratch, '--wait-ms', String(waitMs)], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let stdinError = null
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const stop = answer || onRequest ? answerNext(answer, { forge, onRequest }) : () => undefined
    child.on('close', code => {
      stop()
      resolve({ code, stdout, stderr, stdinError, ms: Number(process.hrtime.bigint() - started) / 1e6 })
    })
    child.stdin.on('error', error => (stdinError = error.code ?? error.message))
    child.stdin.end(stdin)
  })
}

const results = []
const record = async (name, expect, run) => {
  const r = await run()
  const ok = expect(r)
  results.push({ case: name, ok, ms: Math.round(r.ms), stdout: r.stdout || '(none)', stdin: r.stdinError ?? 'read', stderr: r.stderr.trim() || undefined })
}
const none = r => r.code === 0 && r.stdout === '' && r.stdinError === null
const fast = r => none(r) && r.ms < ANSWER_WAIT_MS
const behavior = b => r => r.code === 0 && JSON.parse(r.stdout || '{}').hookSpecificOutput?.decision?.behavior === b && !/updatedInput|updatedPermissions/.test(r.stdout)
const json = JSON.stringify(sample())
const median = list => Math.round([...list].sort((a, b) => a - b)[Math.floor(list.length / 2)])

try {
  await record('no server (no companion.json)', fast, () => runHook(json))
  fs.writeFileSync(path.join(scratch, 'companion.json'), JSON.stringify({ port: 1, token: 'x', pid: 999_999 }))
  await record('server pid not alive', fast, () => runHook(json))
  const noServerTimes = []
  for (let i = 0; i < 10; i += 1) noServerTimes.push((await runHook(json)).ms)
  fs.rmSync(path.join(scratch, 'companion.json'))

  await startServer()
  await record('server up, nothing armed', fast, () => runHook(json))
  await record('nothing armed, 2 MB stdin drained', none, () => runHook(JSON.stringify(sample({ tool_input: { content: 'x'.repeat(2 * 1024 * 1024) } }))))
  let markerSeen = false
  for (let i = 0; i < 30 && !markerSeen; i += 1) {
    markerSeen = (await api('GET', '/api/state')).body.snapshot.sessions.find(s => s.cliSessionId === sample().session_id)?.status?.bucket === 'needs-you'
    if (!markerSeen) await sleep(100)
  }
  results.push({ case: 'a prompt Orbit does not take still shows as Needs you (E-06 b)', ok: markerSeen, ms: 0, stdout: '(none)', stdin: 'read' })
  const notArmedTimes = []
  for (let i = 0; i < 10; i += 1) notArmedTimes.push((await runHook(json)).ms)
  fs.mkdirSync(approvals, { recursive: true })
  fs.writeFileSync(path.join(approvals, 'enabled.json'), JSON.stringify({ enabled: true }))
  await record('a written enabled.json arms nothing', fast, () => runHook(json, { answer: () => ({ behavior: 'allow' }), waitMs: 2_000 }))

  stream = await openWindow()
  await api('POST', '/api/arm', { capability: 'approvals', armed: true })
  await api('POST', '/api/arm', { capability: 'questions', armed: true })
  await record('armed, window open, not attentive', fast, () => runHook(json))
  await api('POST', '/api/attention', { attentive: true })
  await record('ready, stdin not JSON', none, () => runHook('{"tool_name": "Bash", '))
  await record('ready, no tool_name', none, () => runHook(JSON.stringify(sample({ tool_name: undefined }))))
  await record('ready, session id not plain', fast, () => runHook(JSON.stringify(sample({ session_id: '..\\x' }))))
  await record('ready, session not in Orbit', fast, () => runHook(JSON.stringify(sample({ session_id: '0a1b2c3d-0000-4000-8000-00000000ffff' }))))
  for (const tool of ['ExitPlanMode', 'EnterPlanMode', 'mcp__ccd_session__start_session']) {
    await record(`person-only tool ${tool}`, fast, () => runHook(JSON.stringify(sample({ tool_name: tool })), { answer: () => ({ behavior: 'allow' }), waitMs: 2_000 }))
  }
  await record('allow answer', behavior('allow'), () => runHook(json, { answer: () => ({ behavior: 'allow' }) }))
  await record('deny answer', r => behavior('deny')(r) && /Denied from Orbit/.test(r.stdout), () => runHook(json, { answer: () => ({ behavior: 'deny' }) }))
  await record('ask answer (Answer in Claude)', none, () => runHook(json, { answer: () => ({ behavior: 'ask' }) }))
  await record('wrong-hash allow (refused by the server, expires)', none, () => runHook(json, { answer: () => ({ behavior: 'allow', inputHash: 'f'.repeat(64) }), waitMs: 2_000 }))
  await record('a forged answer file is never read (E-01)', none, () => runHook(json, { answer: () => ({ behavior: 'allow' }), forge: true, waitMs: 2_000 }))
  await record('no answer, expires', none, () => runHook(json, { waitMs: 1_500 }))
  await record('truncated input + allow → back to Claude', none, () => runHook(JSON.stringify(sample({ tool_input: { command: `echo ${'x'.repeat(20_000)}` } })), { answer: () => ({ behavior: 'allow' }), waitMs: 2_000 }))
  await record('window goes away while waiting', r => none(r) && r.ms < 9_500, () =>
    runHook(json, {
      waitMs: 12_000,
      onRequest: () =>
        setTimeout(() => {
          stream.destroy()
          stream = null
        }, 300),
    }),
  )
  stream = await openWindow()
  await api('POST', '/api/attention', { attentive: true })

  const COLOUR = 'Which colour?'
  const FRUIT = 'Which fruits?'
  const questions = [
    { question: COLOUR, header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool', preview: 'blue = 1' }] },
    { question: FRUIT, header: 'Fruit', multiSelect: true, options: [{ label: 'Apple', description: 'Crisp' }, { label: 'Pear', description: 'Soft' }, { label: 'Plum', description: 'Sweet' }] },
  ]
  const question = (input = { questions }) => JSON.stringify(sample({ tool_name: 'AskUserQuestion', tool_input: input }))
  const answered = (answers, annotations) => r => {
    const decision = r.code === 0 && r.stdinError === null ? JSON.parse(r.stdout || '{}').hookSpecificOutput?.decision : null
    if (decision?.behavior !== 'allow' || Object.keys(decision).length !== 2) return false
    const { answers: got, annotations: notes, ...rest } = decision.updatedInput ?? {}
    return JSON.stringify(rest) === JSON.stringify({ questions }) && JSON.stringify(got) === JSON.stringify(answers) && JSON.stringify(notes) === JSON.stringify(annotations)
  }
  let questionView = null
  await record('question: request kind', r => answered({ [COLOUR]: 'Blue', [FRUIT]: 'Pear' })(r) && questionView?.kind === 'question', () =>
    runHook(question(), { answer: () => ({ behavior: 'answer', answers: { [COLOUR]: { labels: ['Blue'] }, [FRUIT]: { labels: ['Pear'] } } }), onRequest: request => (questionView = request) }),
  )
  await record('question: single + multi-select', answered({ [COLOUR]: 'Red', [FRUIT]: 'Apple, Plum' }), () => runHook(question(), { answer: () => ({ behavior: 'answer', answers: { [COLOUR]: { labels: ['Red'] }, [FRUIT]: { labels: ['Plum', 'Apple'] } } }) }))
  await record('question: Other text', answered({ [COLOUR]: 'Teal', [FRUIT]: 'Kiwi' }), () => runHook(question(), { answer: () => ({ behavior: 'answer', answers: { [COLOUR]: { other: 'Teal' }, [FRUIT]: { other: 'Kiwi' } } }) }))
  await record('question: notes as annotations', answered({ [COLOUR]: 'Blue', [FRUIT]: 'Pear' }, { [FRUIT]: { notes: 'Ripe ones' } }), () =>
    runHook(question(), { answer: () => ({ behavior: 'answer', answers: { [COLOUR]: { labels: ['Blue'] }, [FRUIT]: { labels: ['Pear'] } }, notes: { [FRUIT]: 'Ripe ones' } }) }),
  )
  await record('question: typing keeps it open past the hook wait (E-23)', answered({ [COLOUR]: 'Red', [FRUIT]: 'Pear' }), () =>
    runHook(question(), {
      waitMs: 1_500,
      onRequest: request => {
        void api('POST', `/api/approvals/${request.id}/typing`, {})
        setTimeout(() => void api('POST', `/api/approvals/${request.id}`, { inputHash: request.inputHash, behavior: 'answer', answers: { [COLOUR]: { labels: ['Red'] }, [FRUIT]: { labels: ['Pear'] } } }), 2_500)
      },
    }),
  )
  await record('question: Answer in Claude (decline), at once', fast, () => runHook(question(), { answer: () => ({ behavior: 'ask' }) }))
  await record('question: no answer, expires', none, () => runHook(question(), { waitMs: 1_500 }))
  await record('question: allow without answers (refused, expires)', none, () => runHook(question(), { answer: () => ({ behavior: 'allow' }), waitMs: 2_000 }))
  await record('question: label not offered (refused, expires)', none, () => runHook(question(), { answer: () => ({ behavior: 'answer', answers: { [COLOUR]: { labels: ['Green'] }, [FRUIT]: { labels: ['Pear'] } } }), waitMs: 2_000 }))
  await record('question: malformed (one option) left to the desktop', fast, () => runHook(question({ questions: [{ ...questions[0], options: [{ label: 'Red', description: 'Warm' }] }] })))
  await record('question: oversized label left to the desktop', fast, () => runHook(question({ questions: [{ ...questions[0], options: [{ label: 'x'.repeat(201), description: '' }, { label: 'Blue', description: '' }] }] })))
  await api('POST', '/api/arm', { capability: 'questions', armed: false })
  await record('questions disarmed, approvals armed: question left to the desktop', fast, () => runHook(question()))

  const leftOpen = (await api('GET', '/api/approvals')).body.approvals.length
  const leftFiles = fs.existsSync(approvals) ? fs.readdirSync(approvals).filter(n => /^[0-9a-f-]{36}(\.done)?\.json$/.test(n)).length : 0
  console.table(results.map(r => ({ case: r.case, ok: r.ok, ms: r.ms, stdin: r.stdin, stdout: r.stdout.length > 70 ? `${r.stdout.slice(0, 70)}…` : r.stdout })))
  for (const r of results.filter(r => r.stderr)) console.log(`stderr (${r.case}): ${r.stderr}`)
  console.log(`requests still open: ${leftOpen}; request files written by the hook: ${leftFiles}`)
  console.log(`no server: median ${median(noServerTimes)} ms, max ${Math.round(Math.max(...noServerTimes))} ms (10 runs; reported, not checked: it depends on machine load)`)
  console.log(`server up, nothing armed: median ${median(notArmedTimes)} ms, max ${Math.round(Math.max(...notArmedTimes))} ms (10 runs)`)
  if (leftOpen || leftFiles) results.push({ ok: false })
} finally {
  stream?.destroy()
  server?.kill()
  await sleep(300)
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
const failed = results.filter(r => !r.ok).length
console.log(failed ? `hook check: ${failed} FAILED` : 'hook check: ok')
process.exit(failed ? 1 : 0)
