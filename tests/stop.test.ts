import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { inbox, inboxTurn, stopTurn } from '../src/core/inbox'
import { composerButton, stopText } from '../shared/popout.js'
import type { SessionView } from '../types'

function engine(abort: (input: { turnId: string }) => Promise<void>): { $: EngineInterface; aborted: string[] } {
  const aborted: string[] = []
  const $ = { turn: { abort: (input: { turnId: string }) => (aborted.push(input.turnId), abort(input)) } } as unknown as EngineInterface
  return { $, aborted }
}

test('stop: aborts the main turn that was running when the stop was asked for', async () => {
  inboxTurn(true, 't1', 1_000)
  const { $, aborted } = engine(() => Promise.resolve())
  expect(await stopTurn($, 2_000)).toBe('stopped')
  expect(aborted).toEqual(['t1'])
})

test('stop: with no turn running, or a turn begun after the request, nothing is aborted', async () => {
  const { $, aborted } = engine(() => Promise.resolve())
  inboxTurn(false)
  expect(await stopTurn($, 2_000)).toBe('idle')
  inboxTurn(true, 't2', 3_000)
  expect(await stopTurn($, 2_000)).toBe('idle')
  expect(aborted).toEqual([])
})

test('stop: a turn that ends while the abort runs counts as idle; a refused abort of a live turn as failed', async () => {
  inboxTurn(true, 't3', 1_000)
  const ended = engine(() => (inboxTurn(false, 't3'), Promise.reject(new Error('not the running turn'))))
  expect(await stopTurn(ended.$, 2_000)).toBe('idle')
  inboxTurn(true, 't4', 1_000)
  const refused = engine(() => Promise.reject(new Error('no')))
  expect(await stopTurn(refused.$, 2_000)).toBe('failed')
  inboxTurn(false, 't4')
})

test('stop: only the main turn that is ending clears the turn a stop would abort', () => {
  inboxTurn(true, 't5', 1_000)
  inboxTurn(false, 'other')
  expect(inbox.turn?.id).toBe('t5')
  inboxTurn(false, 't5')
  expect(inbox.turn).toBe(null)
})

const session = (lifecycle: string, stopProtocol?: number): SessionView => ({ key: 'local_a', lifecycle, publisher: { replyProtocol: 2, endedAt: null, ...(stopProtocol ? { stopProtocol } : {}) } }) as unknown as SessionView

test('stop: Send becomes Stop only while the session works, the box is empty, replies are on and its Orbit takes stops', () => {
  expect(composerButton(session('running', 1), true, false)).toBe('stop')
  expect(composerButton(session('running', 1), true, true)).toBe('send')
  expect(composerButton(session('running', 1), false, false)).toBe('send')
  expect(composerButton(session('running'), true, false)).toBe('send')
  expect(composerButton(session('idle', 1), true, false)).toBe('send')
  expect(stopText('stopped')).toBe('Stopped.')
  expect(stopText('made-up')).toBe('May not have stopped. Check the session.')
})
