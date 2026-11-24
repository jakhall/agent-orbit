import { expect, test } from 'claude-code/testing'

import { isGroupOpen, openRowKeys, rowMeta } from '../shared/popout.js'

const groups = [
  { key: 'needs-you', rows: [{ key: 'a' }] },
  { key: 'review', rows: [{ key: 'b' }] },
  { key: 'working', rows: [{ key: 'c' }, { key: 'd' }] },
  { key: 'idle', rows: [{ key: 'e' }] },
]

test('2.1 S2: Working and Idle start collapsed; Needs you, Failed and Review start open', () => {
  expect(['needs-you', 'failed', 'review', 'working', 'idle'].map(key => isGroupOpen(key, {}, false))).toEqual([true, true, true, false, false])
})

test("2.1 S2: a group keeps the window's choice, and every group opens while a search is on", () => {
  expect(isGroupOpen('working', { working: true }, false)).toBe(true)
  expect(isGroupOpen('needs-you', { 'needs-you': false }, false)).toBe(false)
  expect(isGroupOpen('idle', { idle: false }, true)).toBe(true)
  expect(isGroupOpen('idle', null, false)).toBe(false)
})

test('2.1 S2: j, k and 1-9 walk the rows of open groups only, in queue order', () => {
  const open = (key: string) => isGroupOpen(key, { idle: true }, false)
  expect(openRowKeys(groups, open)).toEqual(['a', 'b', 'e'])
})

test("2.1 S2: a row's meta line reads as 1.15's: the state and its age first, then the reason", () => {
  expect(rowMeta('needs-you', 'run aws sso login, then tell me')).toEqual({ before: 'Needs you', after: ' · run aws sso login, then tell me' })
  expect(rowMeta('review', 'Finished, not opened since')).toEqual({ before: 'Finished, not opened since', after: '' })
  expect(rowMeta('working', 'Working')).toEqual({ before: 'Running', after: '' })
  expect(rowMeta('idle', 'Stopped reporting')).toEqual({ before: 'Idle', after: ' · Stopped reporting' })
  expect(rowMeta('failed', '')).toEqual({ before: 'Failed', after: '' })
})
