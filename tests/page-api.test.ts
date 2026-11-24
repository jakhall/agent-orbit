import { expect, test } from 'claude-code/testing'

import { attentionPost, isNoWindow, modelOptions, NO_WINDOW_TEXT, paintedStats } from '../shared/popout.js'

const WINDOW = '0123456789abcdef'
const FALLBACK = [{ value: '', label: 'Default' }, { value: 'claude-opus-5-5', label: 'Opus 5.5' }]

test('E-96: attention is posted only with the window id from the latest hello, and an unchanged "not attentive" is not repeated', () => {
  expect(attentionPost(true, null, null)).toBe(null)
  expect(attentionPost(true, 'not-hex', null)).toBe(null)
  expect(attentionPost(true, WINDOW, null)).toEqual({ attentive: true, windowId: WINDOW, selected: null })
  expect(attentionPost(true, WINDOW, { attentive: true, windowId: WINDOW })).toEqual({ attentive: true, windowId: WINDOW, selected: null })
  expect(attentionPost(false, WINDOW, { attentive: true, windowId: WINDOW })).toEqual({ attentive: false, windowId: WINDOW, selected: null })
  expect(attentionPost(false, WINDOW, { attentive: false, windowId: WINDOW })).toBe(null)
  expect(attentionPost(false, 'fedcba9876543210', { attentive: false, windowId: WINDOW })).toEqual({ attentive: false, windowId: 'fedcba9876543210', selected: null })
})

test('E-24: the model menu comes from the launch options route, keeping only well-formed entries, else the built-in list', () => {
  const answer = { models: [{ value: '', label: 'Default' }, { value: 'claude-fable-5-2', label: 'Fable 5.2' }, { value: 7, label: 'bad' }, { label: 'no value' }, { value: 'x'.repeat(101), label: 'too long' }] }
  expect(modelOptions(answer, FALLBACK)).toEqual([{ value: '', label: 'Default' }, { value: 'claude-fable-5-2', label: 'Fable 5.2' }])
  expect(modelOptions(null, FALLBACK)).toBe(FALLBACK)
  expect(modelOptions({ models: [] }, FALLBACK)).toBe(FALLBACK)
  expect(modelOptions({ models: 'nope' }, FALLBACK)).toBe(FALLBACK)
})

test('a 409 with reason no-window is the server waiting for a window to reconnect, not a problem with the request', () => {
  expect(isNoWindow(409, { reason: 'no-window', error: 'Open the Orbit window to act on sessions.' })).toBe(true)
  expect(isNoWindow(409, { error: 'This request changed; it was not answered.' })).toBe(false)
  expect(isNoWindow(409, null)).toBe(false)
  expect(isNoWindow(409, undefined)).toBe(false)
  expect(isNoWindow(503, { reason: 'no-window' })).toBe(false)
  expect(NO_WINDOW_TEXT).toMatch(/^Reconnecting to Orbit/)
})

test('painted stats carry the painted snapshot seq and bootId, and nothing without both', () => {
  expect(paintedStats({ seq: 7, bootId: 'b1', checkedAt: 5 }, 1_000)).toEqual({ painted: { seq: 7, bootId: 'b1', at: 1_000 } })
  expect(paintedStats({ seq: 7 }, 1_000)).toBe(null)
  expect(paintedStats({ seq: 1.5, bootId: 'b1' }, 1_000)).toBe(null)
  expect(paintedStats(null, 1_000)).toBe(null)
})
