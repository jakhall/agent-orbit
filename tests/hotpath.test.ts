import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { NOW } from './fixtures'

const FREE = new Set(['command.register'])

function hangingHost(on: On) {
  let isGated = false
  let release: () => void = () => undefined
  let gate = Promise.resolve()
  const pending: string[] = []
  const wait = async (name: string) => {
    if (!isGated || FREE.has(name)) return
    pending.push(name)
    await gate
  }
  const value = (name: string, v: unknown) => async () => (await wait(name), { value: v }) as never
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', USERPROFILE: 'C:\\Users\\t', APPDATA: 'C:\\Users\\t\\AppData\\Roaming' })
  on('clock.now', value('clock.now', NOW))
  on('clock.after', value('clock.after', { cancel: () => undefined }))
  on('clock.every', value('clock.every', { cancel: () => undefined }))
  on('session.id', value('session.id', 'cli-9'))
  on('session.cwd', value('session.cwd', 'C:\\repo'))
  on('session.model', value('session.model', null))
  on('session.version', value('session.version', { version: '2.1.321' }))
  on('session.repo', value('session.repo', null))
  on('agent.list', value('agent.list', []))
  on('command.register', async (_, e) => (await wait('command.register'), { value: { command: (e as unknown as { name: string }).name } }) as never)
  on('ui.open', value('ui.open', { isPlaced: true }))
  on('ui.panes', value('ui.panes', []))
  on('fs.exists', value('fs.exists', false))
  on('fs.list', value('fs.list', []))
  on('fs.write', value('fs.write', undefined))
  on('fs.read', async () => {
    await wait('fs.read')
    throw new Error('ENOENT')
  })
  on('fs.stat', async () => {
    await wait('fs.stat')
    throw new Error('ENOENT')
  })
  on('process.run', value('process.run', { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return {
    pending,
    hang: () => {
      isGated = true
      gate = new Promise<void>(r => (release = r))
    },
    free: () => {
      isGated = false
      release()
    },
  }
}

const settle = async () => {
  for (let i = 0; i < 300; i += 1) await Promise.resolve()
}

test('no observer awaits a host call before next: tool calls, questions and turn starts reach the engine while every host call hangs (E-12)', async ($, on) => {
  const host = hangingHost(on)
  const reached: string[] = []
  on('tool.call', (_, e) => (reached.push(String(e.tool)), { result: {} }) as never)
  on('turn.start', () => (reached.push('turn.start'), { turnId: 't1' }) as never)
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await settle()
  host.hang()
  const running = [$.turn.start({ text: 'hi', turnId: 't1' } as never), $.tool.call({ tool: 'Bash', command: 'npm test' }), $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)]
  await settle()
  expect(reached.sort()).toEqual(['AskUserQuestion', 'Bash', 'turn.start'])
  host.free()
  await Promise.all(running)
})

function folderHost(on: On, files: Map<string, { text: string; mtimeMs: number }>, isShown = false) {
  const touched: string[] = []
  const asked = { panes: 0 }
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
  on('ui.panes', () => (asked.panes += 1, { value: isShown ? [{ id: 'orbit', isShown: true, isPlaced: true }] : [] }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', (_, e) => (touched.push(pathOf(e)), { value: files.has(pathOf(e)) }) as never)
  on('fs.list', (_, e) => (touched.push(pathOf(e)), { value: [] }) as never)
  on('fs.write', (_, e) => (touched.push(pathOf(e)), { value: undefined }) as never)
  on('fs.read', (_, e) => {
    touched.push(pathOf(e))
    const file = files.get(pathOf(e))
    if (!file) throw new Error('ENOENT')
    return { value: file.text } as never
  })
  on('fs.stat', (_, e) => {
    touched.push(pathOf(e))
    const file = files.get(pathOf(e))
    if (!file) throw new Error('ENOENT')
    return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { touched, clock, asked }
}

const DATA = 'C:\\Users\\t\\.claude\\orbit'
const isInboxCall = (path: string) => path.startsWith(`${DATA}\\inbox\\`)

test('a session with no live pop-out server makes no file calls for replies (E-13)', async ($, on) => {
  const { touched, clock } = folderHost(on, new Map())
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await settle()
  await clock.advance(120_000)
  expect(touched.filter(isInboxCall)).toEqual([])
})

test('a live pop-out server (its heartbeat under 30 s old) turns reply polling on, over HTTP to the server (E-13, A5)', async ($, on) => {
  const companion = { text: JSON.stringify({ port: 1, token: 'control', pid: 1, startedAt: NOW, lastSeenAt: 0, clients: 0 }), mtimeMs: NOW }
  const files = new Map([[`${DATA}\\companion.json`, companion]])
  const fetched: string[] = []
  on('http.fetch', (_, e) => {
    fetched.push((e as unknown as { url: string }).url)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ armed: false, replies: [] }) } } as never
  })
  const { touched, clock } = folderHost(on, files)
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await settle()
  for (let i = 0; i < 8; i += 1) {
    files.set(`${DATA}\\companion.json`, { ...companion, mtimeMs: NOW + i * 10_000 })
    await clock.advance(10_000)
  }
  expect(fetched.includes('http://127.0.0.1:1/api/mod/replies/cli-9')).toBe(true)
  expect(touched.filter(path => isInboxCall(path) && !path.endsWith('seen.json'))).toEqual([])
})

test('a pane drawn after its last tick went stale starts a tick at once, so it never shows an old snapshot for long (E-78)', async ($, on) => {
  const { touched, clock, asked } = folderHost(on, new Map(), true)
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await settle()
  await clock.advance(5_000)
  await settle()
  const afterFirstTick = asked.panes
  await clock.advance(25_000)
  const ui = await $.ui.mount({ plugin: 'orbit', component: 'Pane', requestId: 'orbit', surface: 'desktop', props: { title: 'Orbit', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as never)
  await settle()
  expect(asked.panes).toBeGreaterThan(afterFirstTick)
  expect(touched.length).toBeGreaterThan(0)
  await ui.unmount()
})

test('session.start returns once the commands are registered, while every other host call hangs (E-12)', async ($, on) => {
  const host = hangingHost(on)
  host.hang()
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await settle()
  host.free()
  await settle()
  expect(host.pending.length).toBeGreaterThan(0)
})
