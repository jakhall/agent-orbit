import { expect, test } from 'claude-code/testing'

import { canFirstFit, menuStep } from '../shared/popout.js'

test('2.1 S3: the Snooze menu moves with the arrows, wraps, jumps with Home and End, and closes on Esc or Tab', () => {
  expect(menuStep('ArrowDown', 0, 2)).toEqual({ index: 1 })
  expect(menuStep('ArrowDown', 1, 2)).toEqual({ index: 0 })
  expect(menuStep('ArrowUp', 0, 2)).toEqual({ index: 1 })
  expect(menuStep('Home', 1, 2)).toEqual({ index: 0 })
  expect(menuStep('End', 0, 2)).toEqual({ index: 1 })
  expect(menuStep('Escape', 0, 2)).toEqual({ close: true, refocus: true })
  expect(menuStep('Tab', 0, 2)).toEqual({ close: true, refocus: false })
  expect(menuStep('x', 0, 2)).toBe(null)
})

test('2.1 regression: the first fit waits for a stage with a size (a hidden or minimised window gave a 1x1 fit and a huge view)', () => {
  expect(canFirstFit(null, { width: 0, height: 0 })).toBe(false)
  expect(canFirstFit(null, { width: 900, height: 0 })).toBe(false)
  expect(canFirstFit(null, { width: 900, height: 600 })).toBe(true)
  expect(canFirstFit({ x: 0, y: 0, w: 10, h: 10 }, { width: 0, height: 0 })).toBe(false)
})
