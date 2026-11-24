import { expect, test } from 'claude-code/testing'

import { layoutGraph } from '../shared/layout.js'
import { countOverlaps, countOutside, planPatch } from '../shared/map.js'
import { synthetic } from './fixtures'

const BUCKET = { running: 'working', idle: 'idle', completed: 'idle', 'waiting-user': 'needs-you', stale: 'working' } as const
const denseSnapshot = (n: number, _now: number) => {
  const base = synthetic(12, n, 3)
  return { ...base, sessions: base.sessions.map(s => ({ ...s, status: { bucket: BUCKET[s.lifecycle as keyof typeof BUCKET] ?? 'idle', reason: 'x', since: null, isObserved: false } })) }
}

const NOW = 1_700_000_000_000

test('C1: a patch adds, replaces and removes only what changed, keyed by id, and reorders only when the draw order moved', () => {
  const prev = new Map([['a', '<g a/>'], ['b', '<g b/>'], ['c', '<g c/>']])
  expect(planPatch(prev, [{ id: 'a', markup: '<g a/>' }, { id: 'b', markup: '<g b/>' }, { id: 'c', markup: '<g c/>' }])).toEqual({ add: [], replace: [], remove: [], isReordered: false })
  expect(planPatch(prev, [{ id: 'a', markup: '<g a/>' }, { id: 'b', markup: '<g b2/>' }, { id: 'd', markup: '<g d/>' }])).toEqual({ add: ['d'], replace: ['b'], remove: ['c'], isReordered: false })
  expect(planPatch(prev, [{ id: 'b', markup: '<g b/>' }, { id: 'a', markup: '<g a/>' }, { id: 'c', markup: '<g c/>' }]).isReordered).toBe(true)
})

test('C1 metrics: overlapping label boxes and nodes outside the stage are counted', () => {
  const box = (x: number, y: number, w = 10, h = 10) => ({ x, y, w, h })
  expect(countOverlaps([box(0, 0), box(20, 0), box(40, 0)])).toBe(0)
  expect(countOverlaps([box(0, 0), box(5, 5), box(8, 8)])).toBe(3)
  expect(countOverlaps([box(0, 0), box(10, 0)])).toBe(0)
  const stage = box(0, 0, 100, 100)
  expect(countOutside([box(10, 10), box(95, 10), box(-20, 10), box(10, 120)], stage)).toBe(3)
})

