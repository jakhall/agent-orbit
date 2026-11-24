import { expect, test } from 'claude-code/testing'

import { limitsView } from '../shared/format.js'
import { headerMeters } from '../shared/popout.js'

const NOW = new Date(2026, 10, 13, 14, 30).getTime()
const usage = (five: number, seven: number, observedAt = NOW - 60_000) => ({
  rateLimits: [
    { kind: 'five_hour', percentUsed: five, resetsAt: new Date(NOW + 3_600_000).toISOString() },
    { kind: 'seven_day', percentUsed: seven, resetsAt: new Date(NOW + 86_400_000).toISOString() },
  ],
  evidence: { source: 'mod-events', confidence: 'observed', observedAt, detail: null },
})

test('C11: a limit is normal below 80%, high from 80% and critical from 95%, with its percent', () => {
  const view = limitsView(usage(79.6, 95) as never, NOW)
  expect(view?.parts.map(p => [p.percent, p.level])).toEqual([[80, 'high'], [95, 'critical']])
  expect(limitsView(usage(10, 50) as never, NOW)?.parts.map(p => p.level)).toEqual(['normal', 'normal'])
})

test('C11: the header shows every meter, or only the fullest when compact; none without a reading', () => {
  const view = limitsView(usage(40, 96) as never, NOW)
  expect(headerMeters(view, false).map(m => m.text)).toEqual(['5h 40%', '7d 96%'])
  expect(headerMeters(view, true).map(m => m.text)).toEqual(['7d 96%'])
  expect(headerMeters(null, false)).toEqual([])
})

test('C11: a window that resets on another day names the day, not just the time', () => {
  const view = limitsView(usage(40, 96) as never, NOW)
  expect(view?.parts[0]?.resets).toBe('15:30')
  expect(view?.parts[1]?.resets).toBe('Sat 14 Nov 14:30')
})

test('C11 review #1: known kinds get short names, unknown ones a short form, and the header shows at most two meters with "+N" for the rest', () => {
  const many = { rateLimits: [
    { kind: 'five_hour', percentUsed: 30, resetsAt: null },
    { kind: 'seven_day', percentUsed: 50, resetsAt: null },
    { kind: 'seven_day_opus', percentUsed: 88, resetsAt: null },
    { kind: 'some_new_window_kind_from_the_engine', percentUsed: 3, resetsAt: null },
  ], evidence: { source: 'mod-events', confidence: 'observed', observedAt: NOW, detail: null } }
  const view = limitsView(many as never, NOW)
  expect(view?.parts.map(p => p.text)).toEqual(['5h 30%', '7d 50%', '7d Opus 88%', 'some new… 3%'])
  const meters = headerMeters(view, false)
  expect(meters.map(m => m.text)).toEqual(['7d 50%', '7d Opus 88%'])
  expect(meters[1]?.more).toBe(2)
  expect(headerMeters(view, true).map(m => [m.text, m.more])).toEqual([['7d Opus 88%', 3]])
})

test('C11 review #2-3: an old reading is marked stale; the spoken name leads with the window and level, then the reset and the reading time', () => {
  const old = headerMeters(limitsView(usage(82, 10, NOW - 30 * 60_000) as never, NOW), true)[0]
  expect(old?.isStale).toBe(true)
  expect(old?.name).toBe('5-hour limit, 82% used, running high. Resets 15:30. Reading from 14:00, may be out of date. 1 more in Settings.')
  const fresh = headerMeters(limitsView(usage(40, 96) as never, NOW), true)[0]
  expect(fresh?.isStale).toBe(false)
  expect(fresh?.name).toBe('7-day limit, 96% used, almost used up. Resets Sat 14 Nov 14:30. 1 more in Settings.')
})
