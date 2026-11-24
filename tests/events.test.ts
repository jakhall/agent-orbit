import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { PublishedSession } from '../types'
import { lifecycleOf, messageBlockOf } from '../shared/aggregate/infer.js'
import { NOW } from './fixtures'

const RECORD = 'C:\\Users\\t\\.claude\\orbit\\sessions\\cli-9.json'
const STALE = 10 * 60_000

function eventHost(on: On) {
  const files = new Map<string, string>()
  const pathOf = (e: unknown) => (e as { path: string }).path
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', USERPROFILE: 'C:\\Users\\t', APPDATA: 'C:\\Users\\t\\AppData\\Roaming' })
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'cli-9' }) as never)
  on('session.cwd', () => ({ value: 'C:\\repo' }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('session.version', () => ({ value: { version: '2.1.321' } }) as never)
  on('session.repo', () => ({ value: null }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('command.register', (_, e) => ({ value: { command: (e as unknown as { name: string }).name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', (_, e) => ({ value: files.has(pathOf(e)) }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('fs.read', (_, e) => {
    const text = files.get(pathOf(e))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.stat', (_, e) => {
    const text = files.get(pathOf(e))
    if (text === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: text.length, mtimeMs: NOW, isLink: false } } as never
  })
  on('fs.write', (_, e) => {
    const write = e as unknown as { path: string; text: string }
    files.set(write.path, write.text)
    return { value: undefined } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'ag-1' }) as never)
  const settle = async () => {
    for (let i = 0; i < 2_000; i += 1) await Promise.resolve()
  }
  const record = () => JSON.parse(files.get(RECORD) ?? 'null') as PublishedSession | null
  const lifecycle = () => lifecycleOf({ desktop: null, publisher: record(), now: clock.now(), staleMs: STALE })
  return { clock, settle, record, lifecycle }
}

test('raising the session events writes the record lifecycleOf reads: running, waiting on a question, idle, ended (E-31)', async ($, on) => {
  const host = eventHost(on)
  let releaseQuestion: () => void = () => undefined
  on('tool.call', async e => {
    if ((e as unknown as { tool: string }).tool === 'AskUserQuestion') await new Promise<void>(r => (releaseQuestion = r))
    return { result: {} } as never
  })
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await host.settle()
  expect(host.record()?.cliSessionId).toBe('cli-9')

  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  await host.settle()
  expect(host.record()?.turn.isRunning).toBe(true)
  expect(host.lifecycle().lifecycle).toBe('running')

  const asking = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await host.settle()
  expect(host.record()?.waiting?.kind).toBe('question')
  expect(host.lifecycle()).toMatchObject({ lifecycle: 'waiting-user', attention: 'question' })
  releaseQuestion()
  await asking
  await host.settle()
  await host.clock.advance(6_000)
  expect(host.record()?.waiting).toBe(null)

  await $.agent.spawn({ prompt: 'look', description: 'Look around', subagentType: 'Explore', provider: 'claude', parentModel: 'claude-opus-5-5' } as never)
  await host.settle()
  await host.clock.advance(6_000)
  expect(host.record()?.agents.map(a => [a.id, a.type, a.status])).toEqual([['ag-1', 'Explore', 'running']])

  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done', durationMs: 1_000, isAborted: false } as never)
  await host.settle()
  expect(host.record()?.turn).toMatchObject({ isRunning: false, lastReason: 'answer' })
  expect(host.lifecycle().lifecycle).not.toBe('running')

  await $.session.end({ reason: 'other', sessionId: 'cli-9' } as never)
  await host.settle()
  expect(typeof host.record()?.endedAt).toBe('number')
  expect(messageBlockOf('cli-9', host.record(), null, host.clock.now())).toBe('ended')
})

test('/orbit opens the pane and answers in the transcript (E-31)', async ($, on) => {
  const host = eventHost(on)
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  await host.settle()
  const result = await $.command.run({ command: 'orbit', args: 'list' } as never)
  expect((result as unknown as { text: string }).text).toBe('Orbit opened.')
})
