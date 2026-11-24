import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT_FILTERS, DEFAULT_SETTINGS } from '../shared/constants.js'
import { defaultPrefs } from '../src/core/prefs'
import { INITIAL_UI } from '../src/state'
import { NOW, synthetic } from './fixtures'

declare const console: { log: (...args: unknown[]) => void }

const NOUNS = ['fs.read', 'fs.write', 'fs.stat', 'fs.list', 'fs.exists', 'session.id', 'session.model', 'session.version', 'session.repo', 'session.cwd', 'agent.list', 'ui.panes', 'ui.open', 'command.register', 'process.run', 'state.get', 'state.set', 'clock.now'] as const

function counted(on: On) {
  const counts: Record<string, number> = {}
  const bump = (name: string) => void (counts[name] = (counts[name] ?? 0) + 1)
  const total = () => Object.values(counts).reduce((a, b) => a + b, 0)
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', USERPROFILE: 'C:\\Users\\t', APPDATA: 'C:\\Users\\t\\AppData\\Roaming' })
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => (bump('session.id'), { value: 'cli-9' }) as never)
  on('session.model', () => (bump('session.model'), { value: null }) as never)
  on('session.version', () => (bump('session.version'), { value: { version: '2.1.321' } }) as never)
  on('session.repo', () => (bump('session.repo'), { value: null }) as never)
  on('agent.list', () => (bump('agent.list'), { value: [] }) as never)
  on('command.register', (_, e) => (bump('command.register'), { value: { command: (e as unknown as { name: string }).name } }) as never)
  on('ui.open', () => (bump('ui.open'), { value: { isPlaced: true } }) as never)
  on('ui.panes', () => (bump('ui.panes'), { value: [] }) as never)
  on('fs.exists', () => (bump('fs.exists'), { value: false }) as never)
  on('fs.list', () => (bump('fs.list'), { value: [] }) as never)
  on('fs.read', () => {
    bump('fs.read')
    throw new Error('ENOENT')
  })
  on('fs.stat', () => {
    bump('fs.stat')
    throw new Error('ENOENT')
  })
  on('fs.write', () => (bump('fs.write'), { value: undefined }) as never)
  on('process.run', () => (bump('process.run'), { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { counts, total, clock, reset: () => NOUNS.forEach(n => delete counts[n]) }
}

test('bench: host calls on the hot path and while idle (A2 before/after)', async ($, on) => {
  const { total, counts, clock, reset } = counted(on)
  let beforeTool = -1
  let beforeTurn = -1
  on('tool.call', () => {
    beforeTool = total()
    return { result: {} } as never
  })
  on('turn.start', (_, e) => {
    beforeTurn = total()
    return { turnId: 't1' } as never
  })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  const startCalls = total()
  const startDetail = { ...counts }
  reset()
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  const turnCalls = beforeTurn
  reset()
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const toolCalls = beforeTool
  reset()
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  const questionCalls = beforeTool
  console.log(`BENCH AskUserQuestion tool.call host calls before next: ${questionCalls}`)
  await clock.advance(5_000)
  reset()
  await clock.advance(60_000)
  const idleMinute = { ...counts }
  console.log(`BENCH session.start host calls before returning: ${startCalls} ${JSON.stringify(startDetail)}`)
  console.log(`BENCH turn.start host calls before next: ${turnCalls}`)
  console.log(`BENCH tool.call host calls before next: ${toolCalls}`)
  console.log(`BENCH idle minute, no pane, no server: ${Object.values(idleMinute).reduce((a, b) => a + b, 0)} ${JSON.stringify(idleMinute)}`)
  expect(startCalls).toBeGreaterThan(0)
})

test('bench: pane render time on a 50-session, 100-sub-agent snapshot (A2 before/after)', async ($, on) => {
  const snapshot = synthetic(10, 50, 2)
  const prefs = { ...defaultPrefs(), updatedAt: 1, settings: { ...DEFAULT_SETTINGS }, filters: { ...DEFAULT_FILTERS } }
  const seeds = new Map<string, unknown>([
    ['snapshot', { shape: 'snapshot-1', value: snapshot }],
    ['prefs', { shape: 'prefs-3', value: prefs }],
    ['ui', { shape: 'ui-2', value: { ...INITIAL_UI } }],
  ])
  on('state.get', async (_, e, next) => {
    const read = (await next(e)) as unknown as { value?: { version?: number } }
    const seeded = seeds.get((e as unknown as { key: string }).key)
    if (read?.value?.version || seeded === undefined) return read as never
    return { value: { value: seeded, version: 0 } } as never
  })
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:\\Users\\t', APPDATA: 'C:\\Users\\t\\AppData\\Roaming', SystemRoot: 'C:\\Windows' })
  const props = { title: 'Orbit', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
  const times: number[] = []
  for (let i = 0; i < 8; i += 1) {
    const started = Date.now()
    const ui = await $.ui.mount({ plugin: 'orbit', component: 'Pane', requestId: 'orbit', props, surface: 'desktop' } as never)
    times.push(Date.now() - started)
    await ui.unmount()
  }
  const sorted = [...times].sort((a, b) => a - b)
  console.log(`BENCH pane mount+render ms over 8 runs: median ${sorted[4]}, max ${sorted.at(-1)}, all ${times.join(',')} (snapshot ${JSON.stringify(snapshot).length} bytes)`)
  expect(times.length).toBe(8)
})

test('bench: the render hook own time in a reader session, from its published pane stats (A2 before/after)', async ($, on) => {
  const DATA = 'C:\\Users\\t\\.claude\\orbit'
  const snapshot = { ...synthetic(10, 50, 2), generatedAt: NOW }
  const store = new Map<string, string>([
    [`${DATA}\\snapshot.json`, JSON.stringify(snapshot)],
    [`${DATA}\\leader.json`, JSON.stringify({ owner: 'someone-else', heartbeatAt: NOW + 10 * 60_000, version: '99.0.0' })],
  ])
  const writes: { path: string; text: string }[] = []
  const pathOf = (e: unknown) => (e as { path: string }).path
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', USERPROFILE: 'C:\\Users\\t', APPDATA: 'C:\\Users\\t\\AppData\\Roaming' })
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'cli-9' }) as never)
  on('session.model', () => ({ value: null }) as never)
  on('session.version', () => ({ value: { version: '2.1.321' } }) as never)
  on('session.repo', () => ({ value: null }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('command.register', (_, e) => ({ value: { command: (e as unknown as { name: string }).name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [{ id: 'orbit', isShown: true, isPlaced: true }] }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', (_, e) => ({ value: store.has(pathOf(e)) }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('fs.write', (_, e) => {
    const w = e as unknown as { path: string; text: string }
    writes.push(w)
    store.set(w.path, w.text)
    return { value: undefined } as never
  })
  on('fs.read', (_, e) => {
    const text = store.get(pathOf(e))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.stat', (_, e) => {
    const text = store.get(pathOf(e))
    if (text === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: text.length, mtimeMs: NOW, isLink: false } } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  for (let i = 0; i < 2_000; i += 1) await Promise.resolve()
  await clock.advance(4_000)
  const props = { title: 'Orbit', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
  for (let i = 0; i < 8; i += 1) {
    const ui = await $.ui.mount({ plugin: 'orbit', component: 'Pane', requestId: 'orbit', props, surface: 'desktop' } as never)
    await ui.unmount()
  }
  await clock.advance(130_000)
  const records = writes.filter(w => w.path.endsWith('sessions\\cli-9.json')).map(w => JSON.parse(w.text) as { pane?: { renders: number; avgMs: number; maxMs: number } })
  const pane = records.at(-1)?.pane
  console.log(`BENCH render hook in a reader session, 8 draws of a ${JSON.stringify(snapshot).length}-byte snapshot: computed ${pane?.renders ?? 0}, avg ${pane?.avgMs ?? '?'} ms, max ${pane?.maxMs ?? '?'} ms`)
  expect(records.length).toBeGreaterThan(0)
})
