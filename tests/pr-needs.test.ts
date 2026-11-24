import { expect, test } from 'claude-code/testing'

import type { PrStatus } from '../types'
import { prProblem, prProblems } from '../shared/filters.js'
import { NOW, session } from './fixtures'

const PR7 = 'https://github.com/a/b/pull/7'
const link = (url: string, number: number) => ({ url, number, repo: 'a/b', branch: null, state: 'OPEN' })
const status = (patch: Partial<PrStatus> = {}): PrStatus => ({ state: 'open', checks: 'passing', failing: [], review: null, checkedAt: NOW, ...patch })

test('after C9: each problem PR belongs to the newest session linking it, worded with its repository and number, from when the problem was first seen', () => {
  const sessions = [
    session('local_old', { prs: [link(PR7, 7)], lastActivityAt: NOW - 3_600_000 }),
    session('local_new', { prs: [link(PR7, 7)], lastActivityAt: NOW - 60_000 }),
    session('local_plain'),
  ]
  const failing = prProblems(sessions, { [PR7]: status({ checks: 'failing', since: NOW - 120_000 }) }, NOW)
  expect([...failing.entries()]).toEqual([['local_new', { reason: 'PR checks failing: a/b#7', since: NOW - 120_000 }]])
  expect(prProblems(sessions, { [PR7]: status({ review: 'changes', since: NOW - 5_000 }) }, NOW).get('local_new')?.reason).toBe('PR changes requested: a/b#7')
  expect(prProblems(sessions, null, NOW).size).toBe(0)
  for (const quiet of [status({ state: 'merged', checks: 'failing' }), status({ state: 'closed', review: 'changes' }), status({ checks: 'pending' })]) {
    expect(prProblem(quiet)).toBeNull()
    expect(prProblems(sessions, { [PR7]: quiet }, NOW).size).toBe(0)
  }
})

test('after C9: a session idle for over a day, or hidden, does not get the PR need (and it does not pass to an older session)', () => {
  const failing = { [PR7]: status({ checks: 'failing', since: NOW - 120_000 }) }
  const older = session('local_older', { prs: [link(PR7, 7)], lastActivityAt: NOW - 2 * 3_600_000 })
  expect(prProblems([older, session('local_stale', { prs: [link(PR7, 7)], lastActivityAt: NOW - 3_600_000 })], failing, NOW + 24 * 3_600_000).size).toBe(0)
  const newest = session('local_new', { prs: [link(PR7, 7)], lastActivityAt: NOW - 60_000 })
  expect(prProblems([older, newest], failing, NOW, { local_new: NOW - 60_000 }).size).toBe(0)
})
