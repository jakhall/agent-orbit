import { expect, test } from 'claude-code/testing'

import { nearestInDirection, searchMatches } from '../shared/map.js'
import { donePatch, isCharacterKey, KEY_MAP, keyAction, snoozePatch, snoozeUntil } from '../shared/popout.js'

const NOW = new Date(2026, 10, 13, 14, 30).getTime()

test('C6: one key map, one meaning per key', () => {
  const keys = KEY_MAP.map(k => `${k.key}${k.shift ? '+shift' : ''}`)
  expect(new Set(keys).size).toBe(keys.length)
  expect(KEY_MAP.every(k => k.label.length > 0)).toBe(true)
  expect(keyAction({ key: 'n' })).toBe('next-needs-you')
  expect(keyAction({ key: 'N', shiftKey: true })).toBe('previous-needs-you')
  expect(keyAction({ key: 'd' })).toBe('done')
  expect(keyAction({ key: 'a' })).toBe('apply-skill')
  expect(keyAction({ key: 'S', shiftKey: true })).toBe('snooze-tomorrow')
  expect(keyAction({ key: 'ArrowLeft' })).toBe('move-left')
  expect(keyAction({ key: 'ArrowLeft', shiftKey: true })).toBe('pan-left')
  expect(keyAction({ key: '/' })).toBe('search')
  expect(keyAction({ key: 'd', ctrlKey: true })).toBe(null)
  expect(keyAction({ key: 'q' })).toBe(null)
})

const p = (id: string, x: number, y: number) => ({ id, x, y })

test('C6: arrows move focus to the nearest session in that direction, ignoring ones behind or far off to the side', () => {
  const nodes = [p('a', 0, 0), p('right', 100, 10), p('farRight', 300, 0), p('up', 5, -80), p('diag', 60, 90)]
  expect(nearestInDirection(nodes, 'a', 'right')).toBe('right')
  expect(nearestInDirection(nodes, 'a', 'up')).toBe('up')
  expect(nearestInDirection(nodes, 'a', 'down')).toBe('diag')
  expect(nearestInDirection(nodes, 'a', 'left')).toBe(null)
  expect(nearestInDirection(nodes, 'farRight', 'right')).toBe(null)
})

test('C6: search matches title or project, case-insensitively, needs-you first', () => {
  const sessions = [
    { key: 'a', title: 'Billing export', projectId: 'p1', status: { bucket: 'idle' } },
    { key: 'b', title: 'Fix login', projectId: 'p2', status: { bucket: 'needs-you' } },
    { key: 'c', title: 'Docs', projectId: 'p1', status: { bucket: 'working' } },
  ] as never
  const projects = new Map([['p1', { name: 'billing' }], ['p2', { name: 'auth' }]])
  expect(searchMatches(sessions, 'BILL', projects)).toEqual(['a', 'c'])
  expect(searchMatches(sessions, 'auth', projects)).toEqual(['b'])
  expect(searchMatches(sessions, 'i', projects)[0]).toBe('b')
  expect(searchMatches(sessions, '  ', projects)).toEqual([])
})

test('C6: snooze for an hour, or until 9:00 tomorrow; Done, Snooze and their undo are prefs patches', () => {
  expect(snoozeUntil('hour', NOW)).toBe(NOW + 3_600_000)
  expect(new Date(snoozeUntil('tomorrow', NOW)).getHours()).toBe(9)
  expect(new Date(snoozeUntil('tomorrow', NOW)).getDate()).toBe(14)
  expect(donePatch('s1', NOW)).toEqual({ done: { s1: NOW } })
  expect(donePatch('s1', null)).toEqual({ done: { s1: null } })
  expect(snoozePatch('s1', NOW + 10, NOW)).toEqual({ snoozed: { s1: { until: NOW + 10, at: NOW } } })
  expect(snoozePatch('s1', null, NOW)).toEqual({ snoozed: { s1: null } })
})

test('C6 pane follow-ups: digits open the queue’s Nth item, c starts a new session, 0 fits; each key one meaning', () => {
  expect(keyAction({ key: '1' })).toBe('open-1')
  expect(keyAction({ key: '9' })).toBe('open-9')
  expect(keyAction({ key: 'c' })).toBe('new-session')
  expect(keyAction({ key: '0' })).toBe('fit')
  expect(keyAction({ key: 'f' })).toBe(null)
})

test('C6 review: Shift decides upper-case actions (Caps Lock does not), and u undoes the last action', () => {
  expect(keyAction({ key: 'S', shiftKey: false })).toBe('snooze-hour')
  expect(keyAction({ key: 'N', shiftKey: false })).toBe('next-needs-you')
  expect(keyAction({ key: 'D', shiftKey: false })).toBe('done')
  expect(keyAction({ key: 's', shiftKey: true })).toBe('snooze-tomorrow')
  expect(keyAction({ key: 'u' })).toBe('undo')
  expect(isCharacterKey('d')).toBe(true)
  expect(isCharacterKey('/')).toBe(true)
  expect(isCharacterKey('ArrowLeft')).toBe(false)
  expect(isCharacterKey('Escape')).toBe(false)
})
