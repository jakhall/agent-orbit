import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { PublishedSession, Snapshot } from '../types'
import { defaultPrefs } from '../src/core/prefs'
import { buildSnapshot, NOW, pub, session } from './fixtures'

const pathOf = (e: unknown) => (e as { path: string }).path

async function settleStart() {
  for (let i = 0; i < 2_000; i += 1) await Promise.resolve()
}

function startMocks(on: On, files: Record<string, string>, options: { isShown?: boolean; mtimes?: Record<string, number> } = {}) {
  const store = new Map(Object.entries(files))
  const mtimes = new Map(Object.entries(options.mtimes ?? {}))
  const writes: { path: string; text: string }[] = []
  const commands: string[] = []
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', USERPROFILE: 'C:\\Users\\t', APPDATA: 'C:\\Users\\t\\AppData\\Roaming' })
  const clock = mock.clock(on, { now: NOW })
  let sessionId = 'cli-9'
  on('session.id', () => ({ value: sessionId }) as never)
  on('session.cwd', () => ({ value: 'C:\\repo' }) as never)
  on('session.model', () => ({ value: null }) as never)
  on('session.version', () => ({ value: { version: '2.1.317' } }) as never)
  on('session.repo', () => ({ value: null }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('command.register', (_, e) => {
    const name = (e as unknown as { name: string }).name
    commands.push(name)
    return { value: { command: name } } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: options.isShown ? [{ id: 'orbit', isShown: true, isPlaced: true }] : [] }) as never)
  on('fs.exists', (_, e) => ({ value: store.has(pathOf(e)) }) as never)
  on('fs.list', (_, e) => {
    const dir = `${pathOf(e)}\\`
    const names = [...store.keys()].filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('\\'))
    return { value: names.map(p => ({ name: p.slice(dir.length), kind: 'file', size: store.get(p)?.length ?? 0, mtimeMs: mtimes.get(p) ?? NOW, isLink: false })) } as never
  })
  on('fs.read', (_, e) => {
    const text = store.get(pathOf(e))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.stat', (_, e) => {
    const text = store.get(pathOf(e))
    if (text === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: text.length, mtimeMs: mtimes.get(pathOf(e)) ?? NOW, isLink: false } } as never
  })
  on('fs.write', (_, e) => {
    const write = e as unknown as { path: string; text: string }
    writes.push(write)
    store.set(write.path, write.text)
    return { value: undefined } as never
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { writes, clock, commands, store, setSessionId: (id: string) => void (sessionId = id) }
}

test('a desktop session publishes a redacted record of its tool calls', async ($, on) => {
  const { writes, clock } = startMocks(on, {})
  on('tool.call', () => ({ result: {} }) as never)

  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await settleStart()
  const first = writes.find(w => w.path.endsWith('sessions\\cli-9.json'))
  expect(first).toBeDefined()
  expect(JSON.parse(first?.text ?? '{}').entrypoint).toBe('claude-desktop')

  await $.tool.call({ tool: 'Bash', command: 'cd C:\\repo && npm test -- --token=SECRET-VALUE' })
  await clock.advance(6_000)
  const last = writes.filter(w => w.path.endsWith('sessions\\cli-9.json')).at(-1)
  const record = JSON.parse(last?.text ?? '{}') as { tools: { category: string; target: string }[] }
  expect(record.tools.at(-1)).toMatchObject({ category: 'test', target: 'npm test' })
  expect(last?.text).not.toContain('SECRET-VALUE')
})


const NEW_PREFS = 'C:\\Users\\t\\.claude\\orbit\\prefs.json'
const OLD_PREFS = 'C:\\Users\\t\\.claude\\agent-constellation\\prefs.json'
const OLD_TEXT = JSON.stringify({ schema: 1, settings: { refreshSec: 20 }, positions: { 's:x': { dx: 5, dy: 6 } } })

test("the 1.0 mod's preferences are no longer read, and only /orbit is registered (X-1)", async ($, on) => {
  const { writes, commands } = startMocks(on, { [OLD_PREFS]: OLD_TEXT })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await settleStart()
  expect(writes.some(w => w.path === NEW_PREFS || w.path === OLD_PREFS)).toBe(false)
  expect(commands).toEqual(['orbit'])
})

test('a measurement publishes the context, cost and rate limits', async ($, on) => {
  const { writes, clock } = startMocks(on, {})
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await settleStart()
  await $.session.measure({
    context: { tokens: 50_000, window: 200_000, percent: 25 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 41.5, resetsAt: '2026-11-07T09:00:00Z' }],
    cost: { usd: 1.237 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  await clock.advance(6_000)
  const last = writes.filter(w => w.path.endsWith('sessions\\cli-9.json')).at(-1)
  const record = JSON.parse(last?.text ?? '{}')
  expect(record.context.percent).toBe(25)
  expect(record.cost).toBe(1.24)
  expect(record.rateLimits).toEqual([{ kind: 'five_hour', percentUsed: 42, resetsAt: '2026-11-07T09:00:00Z' }])
  const before = writes.length
  await $.session.measure({
    context: { tokens: 50_400, window: 200_000, percent: 25 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 41.6, resetsAt: '2026-11-07T09:00:00Z' }],
    cost: { usd: 1.239 },
    changed: ['context'],
  })
  await clock.advance(6_000)
  expect(writes.filter(w => w.path.endsWith('sessions\\cli-9.json')).length).toBe(writes.filter((w, i) => i < before && w.path.endsWith('sessions\\cli-9.json')).length)
})

const DATA = 'C:\\Users\\t\\.claude\\orbit'
const LEGACY = 'C:\\Users\\t\\.claude\\agent-constellation\\sessions'

function record(id: string, updatedAt: number, cwd: string, patch: Partial<PublishedSession> = {}): string {
  return JSON.stringify(
    pub({
      cliSessionId: id,
      entrypoint: 'cli',
      cwd,
      repoRoot: cwd,
      startedAt: updatedAt - 60_000,
      updatedAt,
      heartbeatAt: updatedAt,
      turn: { isRunning: true, startedAt: updatedAt - 30_000, endedAt: null, lastReason: null },
      ...patch,
    }),
  )
}

test('a /resume in a terminal session keeps publishing under the resumed id (E-71)', async ($, on) => {
  const { writes, clock, setSessionId } = startMocks(on, {})
  on('tool.call', () => ({ result: {} }) as never)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  await $.session.start({ cwd: 'C:\\repo', surface: 'terminal', isInteractive: true })
  await settleStart()
  await $.session.end({ reason: 'resume', sessionId: 'cli-9' } as never)
  setSessionId('cli-10')
  await clock.advance(6_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.advance(6_000)
  const resumed = writes.filter(w => w.path.endsWith('sessions\\cli-10.json')).at(-1)
  expect(resumed).toBeDefined()
  const record = JSON.parse(resumed?.text ?? '{}') as PublishedSession
  expect(record.endedAt).toBe(null)
  expect(record.tools.at(-1)?.target).toBe('npm test')
})

test('a shown pane reads the server snapshot and never aggregates, leads or writes a snapshot (switch, E-113, G-34)', async ($, on) => {
  const v2 = { ...buildSnapshot([session('local_0a1b2c3d-0000-4000-8000-000000000001', { title: 'From the server' })]), graph: undefined }
  const { writes, clock } = startMocks(on, { [`${DATA}\\snapshot-v2.json`]: JSON.stringify(v2), [`${DATA}\\sessions\\other-1.json`]: record('other-1', NOW - 1_000, 'C:\\repo\\a') }, { isShown: true })
  const sets: { key: string; text: string }[] = []
  on('state.set', async (_, e, next) => {
    const write = e as unknown as { key: string; value: unknown }
    sets.push({ key: write.key, text: JSON.stringify(write.value) ?? '' })
    return next(e)
  })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await settleStart()
  for (let i = 0; i < 6; i += 1) await clock.advance(1_000)
  await settleStart()
  expect(sets.filter(s => s.key === 'snapshotVersion').at(-1)?.text).toContain(`"at":${NOW}`)
  expect(writes.some(w => /snapshot(-v2)?\.json$|leader\.json$/.test(w.path))).toBe(false)
  expect(sets.filter(s => s.key === 'snapshot').length).toBe(0)
  expect(sets.some(s => s.key === 'snapshotVersion')).toBe(true)
  const diag = sets.filter(s => s.key === 'diag').at(-1)?.text ?? ''
  expect(diag).toContain('"role":"reader"')
  expect(diag).toContain('"read"')
})

test('a snapshot in a newer format keeps the last one and says why (switch)', async ($, on) => {
  const { store, clock } = startMocks(on, { [`${DATA}\\snapshot-v2.json`]: JSON.stringify({ schema: 3, sessions: [] }) }, { isShown: true })
  const sets: { key: string; text: string }[] = []
  on('state.set', async (_, e, next) => {
    const write = e as unknown as { key: string; value: unknown }
    sets.push({ key: write.key, text: JSON.stringify(write.value) ?? '' })
    return next(e)
  })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await settleStart()
  for (let i = 0; i < 3; i += 1) await clock.advance(1_000)
  await settleStart()
  expect(sets.filter(s => s.key === 'diag').at(-1)?.text ?? '').toContain('Snapshot format 3 is newer')
  expect(store.has(`${DATA}\\snapshot.json`)).toBe(false)
})
