import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { proofOf } from '../shared/proof.js'
import { NOW } from './fixtures'

const DATA = 'C:\\Users\\t\\.claude\\orbit'
const INBOX = `${DATA}\\inbox\\cli-9`
const ID = '0a1b2c3d-0000-4000-8000-0000000000e1'

type Reply = Record<string, unknown>

/**
 * A session whose Orbit server (faked behind `http.fetch`) holds `replies`
 * for it; `events` records claims, acknowledgements and submits in order.
 * It answers each call's nonce with the proof unless `proof` says otherwise.
 */
function replyHost(on: On, replies: Reply[], options: { proof?: 'wrong' | 'missing'; armed?: boolean; withdrawn?: Set<string>; files?: Map<string, string>; notices?: Reply[]; dropClaimed?: boolean; commands?: { name: string; description: string; source: string }[] } = {}) {
  const events: string[] = []
  const acks: Reply[] = []
  const files = options.files ?? new Map<string, string>()
  const claimed = new Set<string>()
  const published: { name: string }[][] = []
  const pathOf = (e: unknown) => (e as { path: string }).path
  files.set(`${DATA}\\companion.json`, JSON.stringify({ port: 47999, token: 'control', pid: 1, startedAt: NOW, lastSeenAt: 0, clients: 0 }))
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', USERPROFILE: 'C:\\Users\\t', APPDATA: 'C:\\Users\\t\\AppData\\Roaming' })
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'cli-9' }) as never)
  on('session.model', () => ({ value: null }) as never)
  on('session.version', () => ({ value: { version: '2.1.321' } }) as never)
  on('session.repo', () => ({ value: null }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('command.register', (_, e) => ({ value: { command: (e as unknown as { name: string }).name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_, e) => ({ value: files.has(pathOf(e)) }) as never)
  on('fs.read', (_, e) => {
    const text = files.get(pathOf(e))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.write', (_, e) => {
    const write = e as unknown as { path: string; text: string }
    if (write.path.startsWith(INBOX)) events.push(`write ${write.path.slice(INBOX.length + 1)}`)
    files.set(write.path, write.text)
    return { value: undefined } as never
  })
  on('fs.stat', (_, e) => {
    const path = pathOf(e)
    if (path === `${DATA}\\companion.json`) return { value: { kind: 'file', size: 10, mtimeMs: clock.now(), isLink: false } } as never
    const text = files.get(path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: text.length, mtimeMs: NOW, isLink: false } } as never
  })
  on('fs.list', (_, e) => {
    const dir = `${pathOf(e)}\\`
    const names = [...files.keys()].filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('\\'))
    return { value: names.map(p => ({ name: p.slice(dir.length), kind: 'file', size: 10, mtimeMs: NOW, isLink: false })) } as never
  })
  on('http.fetch', async (_, e) => {
    const { url, init } = e as unknown as { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }
    const route = url.replace('http://127.0.0.1:47999', '')
    const body = init?.body ? (JSON.parse(init.body) as { cli?: string; ack?: Reply }) : {}
    const nonce = init?.headers?.['x-orbit-nonce'] ?? ''
    const proof = options.proof === 'missing' ? null : await proofOf(options.proof === 'wrong' ? 'not-the-token' : 'control', nonce)
    const answer = (status: number, value: unknown) => ({ value: { status, ok: status === 200, headers: proof ? { 'x-orbit-proof': proof } : {}, text: JSON.stringify(value) } }) as never
    if (init?.headers?.['x-orbit-token'] !== 'control') return answer(403, { error: 'bad token' })
    if (route === '/api/mod/replies/cli-9') return answer(200, { armed: options.armed ?? true, replies: options.dropClaimed ? replies.filter(r => !claimed.has(String(r.id))) : replies })
    if (route === '/api/mod/commands/cli-9') {
      published.push((body as unknown as { commands: { name: string }[] }).commands)
      return answer(200, { ok: true })
    }
    if (route === '/api/mod/notices') return answer(200, { notices: options.notices ?? [] })
    const noticeClaim = /^\/api\/mod\/notices\/(\w+)\/claim$/.exec(route)
    if (noticeClaim?.[1]) {
      events.push(`notice-claim ${noticeClaim[1]}`)
      const isFirst = !claimed.has(noticeClaim[1])
      claimed.add(noticeClaim[1])
      return answer(200, { ok: isFirst })
    }
    const noticeAck = /^\/api\/mod\/notices\/(\w+)\/ack$/.exec(route)
    if (noticeAck?.[1]) {
      events.push(`notice-ack ${noticeAck[1]} ${String((body as { isSent?: unknown }).isSent)}`)
      return answer(200, { ok: true })
    }
    const hold = /^\/api\/mod\/replies\/([0-9a-f-]+)\/hold$/.exec(route)
    if (hold?.[1]) {
      events.push(`hold ${hold[1]}`)
      for (const r of replies) if (r.id === hold[1]) r.held = true
      return answer(200, { ok: !claimed.has(hold[1]) })
    }
    const claim = /^\/api\/mod\/replies\/([0-9a-f-]+)\/claim$/.exec(route)
    if (claim?.[1]) {
      events.push(`claim ${claim[1]}`)
      if (options.withdrawn?.has(claim[1])) return answer(200, { ok: false, reason: 'withdrawn' })
      if (claimed.has(claim[1])) return answer(200, { ok: false, reason: 'replay' })
      claimed.add(claim[1])
      return answer(200, { ok: true })
    }
    const ackRoute = /^\/api\/mod\/replies\/([0-9a-f-]+)\/ack$/.exec(route)
    if (ackRoute?.[1] && body.ack) {
      events.push(`ack ${String(body.ack.status)}`)
      acks.push(body.ack)
      return answer(200, { ok: true })
    }
    return answer(404, { error: 'not found' })
  })
  on('ui.notify', (_, e) => {
    const { text, title, key } = e as unknown as { text: string; title?: string; key?: string }
    events.push(`notify ${key ?? ''} ${title ?? ''}: ${text}`)
    return { value: { isSent: true, channel: 'test' } } as never
  })
  on('turn.start', (_, e) => ({ turnId: (e as unknown as { turnId: string }).turnId }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('classic.PostToolBatch', () => ({}) as never)
  on('command.list', () => ({ value: options.commands ?? [] }) as never)
  on('command.run', (_, e) => {
    const run = e as unknown as { command: string; args?: string }
    events.push(`run ${run.command}${run.args ? ` ${run.args}` : ''}`)
    return { value: {} } as never
  })
  on('prompt.submit', (_, e) => {
    events.push('submit')
    return { text: (e as unknown as { text: string }).text } as never
  })
  return { events, acks, clock, files, published }
}

const reply = (patch: Reply = {}): Reply => ({ schema: 1, id: ID, to: 'cli-9', text: 'Yes, go ahead', createdAt: NOW, ...patch })

async function runFor(clock: { advance: (ms: number) => Promise<void> }, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) await clock.advance(1_000)
}

test('a reply from the server is remembered and claimed before it is submitted, and submitted once however often it is handed out (E-32, A5)', async ($, on) => {
  const { events, acks, clock } = replyHost(on, [reply()])
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await runFor(clock, 40_000)
  expect(events.filter(e => e === 'submit')).toEqual(['submit'])
  const submitAt = events.indexOf('submit')
  expect(events.indexOf('write seen.json')).toBeLessThan(submitAt)
  expect(events.indexOf(`claim ${ID}`)).toBeLessThan(submitAt)
  expect(acks[0]).toMatchObject({ id: ID, status: 'sent' })
})

test('a server answer without the proof for its nonce is ignored: a wrong or missing proof delivers nothing and claims nothing', async ($, on) => {
  const { events, clock } = replyHost(on, [reply()], { proof: 'wrong' })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await runFor(clock, 20_000)
  expect(events.includes('submit')).toBe(false)
  expect(events.some(e => e.startsWith('claim'))).toBe(false)
})

test('a server answer with no proof header is ignored like a wrong one', async ($, on) => {
  const { events, clock } = replyHost(on, [reply()], { proof: 'missing' })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await runFor(clock, 20_000)
  expect(events.includes('submit')).toBe(false)
  expect(events.some(e => e.startsWith('claim'))).toBe(false)
})

test('a reply withdrawn before the claim is never submitted (E-32)', async ($, on) => {
  const { events, acks, clock } = replyHost(on, [reply()], { withdrawn: new Set([ID]) })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await runFor(clock, 20_000)
  expect(events.includes('submit')).toBe(false)
  expect(acks[0]).toMatchObject({ status: 'refused', reason: 'withdrawn' })
})

test('a request whose id this session has already seen is a replay: refused, never submitted (E-32)', async ($, on) => {
  const files = new Map([[`${INBOX}\\seen.json`, JSON.stringify({ ids: [ID] })]])
  const { events, acks, clock } = replyHost(on, [reply()], { files })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await runFor(clock, 20_000)
  expect(events.includes('submit')).toBe(false)
  expect(acks[0]).toMatchObject({ reason: 'replay' })
})

test('while replies are not armed the mod delivers nothing, a launch first prompt included (D-6, honoured by the mod)', async ($, on) => {
  const first = '0a1b2c3d-0000-4000-8000-0000000000e2'
  const { events, clock } = replyHost(on, [reply(), reply({ id: first, text: 'Fix the login bug', firstPrompt: true })], { armed: false })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await runFor(clock, 20_000)
  expect(events.includes('submit')).toBe(false)
  expect(events.includes(`claim ${ID}`)).toBe(false)
  expect(events.includes(`claim ${first}`)).toBe(false)
})

test('a request file written into the inbox folder is never read or submitted (E-02)', async ($, on) => {
  const files = new Map([[`${INBOX}\\${ID}.json`, JSON.stringify(reply())]])
  const { events, clock } = replyHost(on, [], { files })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await runFor(clock, 20_000)
  expect(events.includes('submit')).toBe(false)
  expect(events.some(e => e.startsWith('claim'))).toBe(false)
})

test('notices from the server are raised natively through the person channel, each by one session, and acknowledged (G-20)', async ($, on) => {
  const notice = { id: 'n1', sessionKey: 'local_a', kind: 'needs-you', title: 'Needs you · Fix login', body: 'Asked you a question', at: NOW }
  const { events, clock } = replyHost(on, [], { notices: [notice] })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await runFor(clock, 10_000)
  expect(events.filter(e => e.startsWith('notify'))).toEqual(['notify n1 Needs you · Fix login: Asked you a question'])
  expect(events.indexOf('notice-claim n1')).toBeLessThan(events.indexOf('notify n1 Needs you · Fix login: Asked you a question'))
  expect(events.includes('notice-ack n1 true')).toBe(true)
})

const STEER = 'The user sent this message from Orbit while you were working.'

test('a reply that arrives mid-turn is held, then steered into the turn after its next tool batch: claimed, acknowledged as sent, never submitted', async ($, on) => {
  const { events, acks, clock } = replyHost(on, [reply()], { dropClaimed: true })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  await runFor(clock, 6_000)
  expect(events.includes(`hold ${ID}`)).toBe(true)
  expect(events.includes(`claim ${ID}`)).toBe(false)
  const batch = (await $.classic.PostToolBatch({ tool_calls: [] } as never)) as { additionalContext?: string[] }
  expect(batch.additionalContext?.length).toBe(1)
  expect(batch.additionalContext?.[0]?.startsWith(STEER)).toBe(true)
  expect(batch.additionalContext?.[0]?.endsWith('Yes, go ahead')).toBe(true)
  expect(events.includes(`claim ${ID}`)).toBe(true)
  expect(acks[0]).toMatchObject({ id: ID, status: 'sent' })
  const again = (await $.classic.PostToolBatch({ tool_calls: [] } as never)) as { additionalContext?: string[] }
  expect(again.additionalContext ?? []).toEqual([])
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done', durationMs: 1_000, isAborted: false } as never)
  await runFor(clock, 6_000)
  expect(events.includes('submit')).toBe(false)
})

test('a held reply marked to wait is not steered; it is submitted as the person once the turn ends', async ($, on) => {
  const { events, acks, clock } = replyHost(on, [reply({ wait: true })], { dropClaimed: true })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  await runFor(clock, 6_000)
  const batch = (await $.classic.PostToolBatch({ tool_calls: [] } as never)) as { additionalContext?: string[] }
  expect(batch.additionalContext ?? []).toEqual([])
  expect(events.includes('submit')).toBe(false)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done', durationMs: 1_000, isAborted: false } as never)
  await runFor(clock, 6_000)
  expect(events.filter(e => e === 'submit')).toEqual(['submit'])
  expect(acks[0]).toMatchObject({ id: ID, status: 'sent' })
})

test('a subagent tool batch never steers a held reply', async ($, on) => {
  const { events, clock } = replyHost(on, [reply()], { dropClaimed: true })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  await runFor(clock, 6_000)
  const batch = (await $.classic.PostToolBatch({ tool_calls: [], agent_id: 'a1' } as never)) as { additionalContext?: string[] }
  expect(batch.additionalContext ?? []).toEqual([])
  expect(events.includes(`claim ${ID}`)).toBe(false)
})

const COMMANDS = [
  { name: 'compact', description: 'Clear history but keep a summary', source: 'builtin' },
  { name: 'remote-control', description: 'Toggle Remote Control', source: 'builtin' },
  { name: 'config', description: 'Open settings', source: 'builtin' },
]

test('the session publishes the commands Orbit may run, deny-listed ones left out, and a listed command is run with its arguments, never submitted', async ($, on) => {
  const { events, acks, clock, published } = replyHost(on, [reply({ text: '/compact keep the plan' })], { commands: COMMANDS })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await runFor(clock, 10_000)
  expect(published[0]?.map(c => c.name)).toEqual(['compact', 'remote-control', 'rename'])
  expect(events.filter(e => e.startsWith('run') || e === 'submit')).toEqual(['run compact keep the plan'])
  expect(acks[0]).toMatchObject({ id: ID, status: 'sent' })
})

test('a plugin skill is published with its plugin name; other sources never carry one', async ($, on) => {
  const commands = [
    { name: 'agent-toolbox:tb-lean', description: 'Lean', source: 'plugin', plugin: 'agent-toolbox' },
    { name: 'ab-grilling', description: 'Grill', source: 'user', plugin: 'stray' },
  ]
  const { clock, published } = replyHost(on, [], { commands })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await runFor(clock, 10_000)
  const sent = published[0] as unknown as { name: string; plugin?: string }[]
  expect(sent.find(c => c.name === 'agent-toolbox:tb-lean')?.plugin).toBe('agent-toolbox')
  expect(sent.find(c => c.name === 'ab-grilling')?.plugin).toBeUndefined()
})

test('a desktop session that hides /remote-control from its list still publishes it, so the switch can press it', async ($, on) => {
  const { clock, published } = replyHost(on, [], { commands: COMMANDS.filter(c => c.name !== 'remote-control') })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await runFor(clock, 10_000)
  expect(published[0]?.map(c => c.name)).toEqual(['compact', 'remote-control', 'rename'])
})

test('a command that arrives mid-turn is never steered: it runs once the turn ends', async ($, on) => {
  const { events, clock } = replyHost(on, [reply({ text: '/remote-control' })], { commands: COMMANDS, dropClaimed: true })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  await runFor(clock, 6_000)
  const batch = (await $.classic.PostToolBatch({ tool_calls: [] } as never)) as { additionalContext?: string[] }
  expect(batch.additionalContext ?? []).toEqual([])
  expect(events.some(e => e.startsWith('run'))).toBe(false)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done', durationMs: 1_000, isAborted: false } as never)
  await runFor(clock, 6_000)
  expect(events.filter(e => e.startsWith('run') || e === 'submit')).toEqual(['run remote-control'])
})

test('a command the session does not list, or a deny-listed one, is refused and never run or submitted', async ($, on) => {
  const second = '0a1b2c3d-0000-4000-8000-0000000000e3'
  const { events, acks, clock } = replyHost(on, [reply({ text: '/config' }), reply({ id: second, text: '/made-up now' })], { commands: COMMANDS })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await runFor(clock, 10_000)
  expect(events.filter(e => e.startsWith('run') || e === 'submit')).toEqual([])
  expect(acks.slice(0, 2).map(a => a.reason)).toEqual(['command', 'command'])
})
