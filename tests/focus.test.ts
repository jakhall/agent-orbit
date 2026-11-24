import { expect, test } from 'claude-code/testing'

import { keyInScope, nextFocusKey } from '../shared/popout.js'

test('RC #1: when a row leaves the queue, focus goes to the row after it, else the one before, else nowhere (the map)', () => {
  expect(nextFocusKey(['a', 'b', 'c'], 'b')).toBe('c')
  expect(nextFocusKey(['a', 'b', 'c'], 'c')).toBe('b')
  expect(nextFocusKey(['a'], 'a')).toBe(null)
  expect(nextFocusKey(['a', 'b'], 'z')).toBe(null)
})

test('RC #1: u undoes from anywhere while the toast offers it; other character keys still need focus in the map, queue, card or panel', () => {
  expect(keyInScope({ isCharacter: true, inScope: false, action: 'undo', toastShown: true })).toBe(true)
  expect(keyInScope({ isCharacter: true, inScope: false, action: 'undo', toastShown: false })).toBe(false)
  expect(keyInScope({ isCharacter: true, inScope: false, action: 'done', toastShown: true })).toBe(false)
  expect(keyInScope({ isCharacter: true, inScope: true, action: 'done', toastShown: false })).toBe(true)
  expect(keyInScope({ isCharacter: false, inScope: false, action: 'move-left', toastShown: false })).toBe(true)
})
