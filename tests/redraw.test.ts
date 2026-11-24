import { expect, test } from 'claude-code/testing'

import type { ConversationRow } from '../types'
import { chatRowId, endedCardFate, endedCardNote, pruneById, rowCacheKey, FIELD_GONE_HOLD_MS, fieldFate, liveAnswerFits, pollErrorStep, type Send } from '../shared/popout.js'
import { NOW, session } from './fixtures'

const T = 1_700_000_000_000

test('a field that ended while focused stays in place, disabled, until focus leaves; unfocused it goes at once', () => {
  expect(fieldFate(true, true)).toBe('live')
  expect(fieldFate(false, true)).toBe('live')
  expect(fieldFate(true, false)).toBe('frozen')
  expect(fieldFate(false, false)).toBe('gone')
})

const sendOf = (key: string, status: Send['status']): Send => ({ key, draft: `Text for ${key}`, status, message: 'x' })

test('regression E-101: a reply poll that errors keeps polling until the deadline; a 404 or the deadline makes it unknown, never a plain failure', () => {
  expect(pollErrorStep(500, T, T + 60_000)).toBe('retry')
  expect(pollErrorStep(0, T, T + 60_000)).toBe('retry')
  expect(pollErrorStep(403, T, T + 60_000)).toBe('retry')
  expect(pollErrorStep(404, T, T + 60_000)).toBe('unknown')
  expect(pollErrorStep(500, T + 60_000, T + 60_000)).toBe('unknown')
})

const row = (o: number): ConversationRow => ({ who: 'claude', text: `row ${o}`, at: null, o, i: 0 }) as ConversationRow

test('regression E-102: a live answer joins the rows only if they still end where it was asked from; an older page that cut the newest rows makes it miss', () => {
  const held = [1, 2, 3, 4, 5].map(row)
  expect(liveAnswerFits(held, false, 5)).toBe(true)
  expect(liveAnswerFits([0, ...[1, 2, 3, 4, 5]].map(row), false, 5)).toBe(true)
  const cut = [0, 1, 2, 3].map(row)
  expect(liveAnswerFits(cut, true, 5)).toBe(false)
  expect(liveAnswerFits(cut, false, 5)).toBe(false)
  expect(liveAnswerFits(null, false, 5)).toBe(false)
})

test('regression E-93: a chat row is redrawn when its text changes, even at the same length', () => {
  const mark = { day: null, head: true, turn: true }
  const a = { who: 'tools', text: '… +1 more · 4 tools', at: 5, o: 10, i: 0 } as ConversationRow
  const b = { ...a, text: '… +2 more · 5 tools' }
  expect(a.text.length).toBe(b.text.length)
  expect(rowCacheKey(a, 0, mark)).not.toBe(rowCacheKey(b, 0, mark))
  expect(rowCacheKey(a, 0, mark)).toBe(rowCacheKey({ ...a }, 0, mark))
  expect(rowCacheKey(a, 0, mark)).not.toBe(rowCacheKey(a, 0, { ...mark, head: false }))
})

test('regression E-106: per-request and per-message state is pruned to what is still live', () => {
  const map = new Map([['r1', 1], ['r2', 2]])
  const set = new Set(['local_a|1:0', 'local_b|2:0'])
  pruneById(map, id => id === 'r2')
  pruneById(set, id => id.startsWith('local_a|'))
  expect([...map.keys()]).toEqual(['r2'])
  expect([...set]).toEqual(['local_a|1:0'])
})

test('review B0 row 3: a question card is frozen only when it ended while focused and this window did not answer it; the note says how it ended', () => {
  expect(endedCardFate({ hasFocus: true, isAnsweredHere: false })).toBe('freeze')
  expect(endedCardFate({ hasFocus: true, isAnsweredHere: true })).toBe('replace')
  expect(endedCardFate({ hasFocus: false, isAnsweredHere: false })).toBe('replace')
  expect(endedCardNote('expired')).toBe('This question expired. Answer it in Claude.')
  expect(endedCardNote('allow')).toBe('Answered elsewhere.')
  expect(endedCardNote('ask')).toBe('Sent to Claude: answer it there.')
  expect(endedCardNote(undefined)).toBe('This question ended.')
})

test('regression (B0 87625db): a day divider is keyed by the row it precedes, the same row id the row node uses', () => {
  const r = { who: 'you', text: 'hi', at: 5, o: 42, i: 1 } as ConversationRow
  expect(chatRowId(r, 7)).toBe('42:1')
  expect(chatRowId({ ...r, o: undefined, i: undefined } as unknown as ConversationRow, 7)).toBe('n7:0')
  expect(rowCacheKey(r, 7, { head: true, turn: false }).startsWith('42:1|')).toBe(true)
})
