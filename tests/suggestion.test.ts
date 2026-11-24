import { expect, test } from 'claude-code/testing'

import { normalizeDesktop, promptSuggestionOf, SUGGESTION_MAX } from '../shared/aggregate/desktop.js'
import { shownSuggestion, wantsSuggestion } from '../shared/popout.js'
import { NOW } from './fixtures'

const ID = 'local_0a1b2c3d-0000-4000-8000-000000000001'
const ZW = String.fromCodePoint(0x200b)
const NL = String.fromCodePoint(10)
const record = (patch: Record<string, unknown>) => ({ sessionId: ID, lastTurnEdgeAt: NOW - 60_000, ...patch })

test('the desktop suggestion is read only for an idle session, cleaned, and never cut', () => {
  expect(promptSuggestionOf(record({ promptSuggestion: `  run the${ZW} tests${NL} now ` }) as never)).toBe('run the tests now')
  expect(promptSuggestionOf(record({ promptSuggestion: 'go', latestUserFrameAt: NOW }) as never)).toBe(null)
  expect(promptSuggestionOf(record({ promptSuggestion: 'x'.repeat(SUGGESTION_MAX + 1) }) as never)).toBe(null)
  expect([promptSuggestionOf(record({}) as never), promptSuggestionOf(record({ promptSuggestion: 42 }) as never), promptSuggestionOf(record({ promptSuggestion: ` ${ZW} ` }) as never), promptSuggestionOf(null)]).toEqual([null, null, null, null])
})

test('the session view says only whether a suggestion is held, never its text', () => {
  const view = normalizeDesktop(record({ promptSuggestion: 'SECRET suggestion' }) as never, NOW, new Set())
  expect(view?.hasSuggestion).toBe(true)
  expect(JSON.stringify(view)).not.toContain('SECRET')
  expect(normalizeDesktop(record({ hasPromptSuggestion: true }) as never, NOW, new Set())?.hasSuggestion).toBe(true)
  expect(normalizeDesktop(record({}) as never, NOW, new Set())?.hasSuggestion).toBe(false)
})

test('the composer shows the suggestion only with conversation text on, while idle, with nothing in flight and no question', () => {
  const idle = { hasSuggestion: true, lifecycle: 'idle' }
  const on = { text: 'run the tests', showConvo: true, isBusy: false, isAsking: false }
  expect(shownSuggestion(idle, on)).toBe('run the tests')
  expect(shownSuggestion(idle, { ...on, showConvo: false })).toBe(null)
  expect(shownSuggestion({ ...idle, lifecycle: 'running' }, on)).toBe(null)
  expect(shownSuggestion({ ...idle, hasSuggestion: false }, on)).toBe(null)
  expect(shownSuggestion(idle, { ...on, isBusy: true })).toBe(null)
  expect(shownSuggestion(idle, { ...on, isAsking: true })).toBe(null)
  expect(shownSuggestion(idle, { ...on, text: null })).toBe(null)
  expect([wantsSuggestion(idle, true), wantsSuggestion(idle, false), wantsSuggestion({ lifecycle: 'idle' }, true)]).toEqual([true, false, false])
})
