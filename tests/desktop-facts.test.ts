import { expect, test } from 'claude-code/testing'

import { normalizeDesktop } from '../shared/aggregate/desktop.js'
import { NOW } from './fixtures'

const ch = (code: number) => String.fromCodePoint(code)
const LOCAL = 'local_0a1b2c3d-0000-4000-8000-000000000001'
const PARENT = 'local_0a1b2c3d-0000-4000-8000-0000000000aa'
const read = (patch: Record<string, unknown>) => normalizeDesktop({ sessionId: LOCAL, lastTurnEdgeAt: NOW - 60_000, ...patch } as never, NOW, new Set())

test('lineage from the desktop record: hand-off, fork, side session or spawn, by the parent session key (A4)', () => {
  expect(read({ spawnedFrom: { sessionId: PARENT, handOff: true, sideSession: true } })?.parent).toEqual({ key: PARENT, kind: 'hand-off' })
  expect(read({ spawnedFrom: { sessionId: PARENT, userFork: true, sideSession: true } })?.parent).toEqual({ key: PARENT, kind: 'fork' })
  expect(read({ spawnedFrom: { sessionId: PARENT, sideSession: true } })?.parent).toEqual({ key: PARENT, kind: 'side-session' })
  expect(read({ spawnedFrom: { sessionId: PARENT } })?.parent).toEqual({ key: PARENT, kind: 'spawn' })
  expect(read({ forkedFromSessionId: PARENT })?.parent).toEqual({ key: PARENT, kind: 'fork' })
  expect(read({})?.parent).toBe(null)
  expect(read({ spawnedFrom: { sessionId: '..\\elsewhere' } })?.parent).toBe(null)
  expect(read({ spawnedFrom: { sessionId: LOCAL } })?.parent).toBe(null)
})

test('the last-focused time is the desktop record\'s, or null (A4)', () => {
  expect(read({ lastFocusedAt: NOW - 5_000 })?.lastFocusedAt).toBe(NOW - 5_000)
  expect(read({ lastFocusedAt: 'yesterday' })?.lastFocusedAt).toBe(null)
})

test('the last report is plain one-line text, capped at 400, with what the session asks of you (A4)', () => {
  const text = `${ch(0x200b)}Fixed the login bug.${ch(0x2028)}\n\nTests pass. ${'x'.repeat(600)}${ch(0xfeff)}`
  const report = read({ lastTurnReport: text, turnWrapUp: { description: 'Done', needsUser: `Review the ${ch(0x200b)}PR\nplease` } })?.lastReport
  expect(report?.text.startsWith('Fixed the login bug. Tests pass. x')).toBe(true)
  expect(report?.text.length).toBeLessThanOrEqual(400)
  expect([...(report?.text ?? '')].some(c => [0x200b, 0x2028, 0xfeff, 0x0a].includes(c.codePointAt(0) ?? 0))).toBe(false)
  expect([report?.needsUser, report?.ask, report?.at]).toEqual([true, 'Review the PR please', NOW - 60_000])
  expect(read({ turnWrapUp: { description: 'Shipped it' } })?.lastReport).toEqual({ text: 'Shipped it', needsUser: false, ask: null, at: NOW - 60_000 })
  expect(read({})?.lastReport).toBe(null)
})

test('the newest failure mark, by category only, is current when it is later than the last turn edge (A4)', () => {
  expect(read({ errorCategory: 'disk_full', errorAt: NOW - 10_000, error: 'C:\\Users\\jak\\secret path full' })?.failure).toEqual({ category: 'disk_full', at: NOW - 10_000, source: 'error', isCurrent: true })
  expect(read({ priorErrorMark: { source: 'query_error', category: 'cli_fastfail', at: NOW - 90_000 } })?.failure).toEqual({ category: 'cli_fastfail', at: NOW - 90_000, source: 'mark', isCurrent: false })
  const newestCrash = read({ priorErrorMark: { category: 'spawn_failed', at: NOW - 30_000 }, queryCrashes: [{ at: NOW - 50_000, errorCategory: 'old' }, { at: NOW - 20_000, errorCategory: 'process_interrupted', errorMessage: 'secret' }] })?.failure
  expect(newestCrash).toEqual({ category: 'process_interrupted', at: NOW - 20_000, source: 'crash', isCurrent: true })
  expect(read({})?.failure).toBe(null)
})
