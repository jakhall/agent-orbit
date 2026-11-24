import { expect, test } from 'claude-code/testing'

import { cardModel } from '../shared/map.js'
import { keyAction, statusLine, statusOf } from '../shared/popout.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const lookup = {
  sessions: new Map([['local_parent', { title: 'Parent work' }]]),
  projects: new Map([['p1', { name: 'Nodes' }]]),
}
const base = { key: 'local_a', title: 'Restore the hover card', projectId: 'p1', branch: 'orbit-ui', cwd: 'C:/x/Nodes', lastActivityAt: NOW - HOUR, projectSource: 'folder', parent: { key: 'local_parent', kind: 'side-session' } }

test('2.1.2 card: actions sit in the title row (Pin, Done, Snooze, Hide), with no Open', () => {
  const idle = cardModel({ ...base, status: { bucket: 'idle' } } as never, 'idle', lookup as never, NOW)
  expect(idle.head.title).toBe('Restore the hover card')
  expect(idle.head.actions).toEqual(['pin', 'done', 'snooze', 'hide'])
  const waiting = cardModel({ ...base, status: { bucket: 'needs-you', reason: 'Asked you a question', since: NOW - 3 * HOUR }, lastReport: { ask: 'Can I run the migration?' } } as never, 'needs-you', lookup as never, NOW)
  expect(waiting.head.actions).toEqual(['pin', 'done', 'snooze'])
})

test('2.1.2 card: one short status line, then project and branch as facts only when known', () => {
  const idle = cardModel({ ...base, status: { bucket: 'idle' } } as never, 'idle', lookup as never, NOW)
  expect(idle.status).toBe('Idle')
  expect(idle.facts).toEqual([
    { icon: 'folder', text: 'Nodes', label: 'Project · C:/x/Nodes' },
    { icon: 'branch', text: 'orbit-ui', label: 'Branch' },
  ])
  const working = cardModel({ ...base, branch: null, projectId: 'gone', status: { bucket: 'working', reason: 'Running tests' } } as never, 'working', lookup as never, NOW)
  expect(working.status).toBe('Running · Running tests')
  expect(working.facts).toEqual([])
})

test('2.1.2 card: the text block is the ask for needs-you, else the last report; no provenance, lineage or other extra lines', () => {
  const waiting = cardModel({ ...base, status: { bucket: 'needs-you', reason: 'Asked you a question', since: NOW - 3 * HOUR }, lastReport: { ask: 'Can I run the migration?', text: 'Done with step one.' } } as never, 'needs-you', lookup as never, NOW)
  expect(waiting.status).toBe('Needs you 3h · Asked you a question')
  expect(waiting.body).toBe('Can I run the migration?')
  const idle = cardModel({ ...base, status: { bucket: 'idle' }, lastReport: { ask: null, text: 'Finished the  refactor.\n\nAll tests pass.' } } as never, 'idle', lookup as never, NOW)
  expect(idle.body).toBe('Finished the refactor. All tests pass.')
  const text = JSON.stringify([waiting, idle])
  expect(text).not.toContain('by its start folder')
  expect(text).not.toContain('In Nodes')
  expect(text).not.toContain('Side session')
  expect(text).not.toContain('Parent work')
  expect(text).not.toContain('Asks:')
})

test('2.1.2: with the quick menu gone, d, h, s and Shift+S still map to their actions', () => {
  expect(keyAction({ key: 'd' })).toBe('done')
  expect(keyAction({ key: 'h' })).toBe('hide')
  expect(keyAction({ key: 's' })).toBe('snooze-hour')
  expect(keyAction({ key: 'S', shiftKey: true })).toBe('snooze-tomorrow')
})

test('2.1.2: the card says a session\'s status exactly as its left-column row does', () => {
  const statuses = [
    { bucket: 'needs-you', reason: 'Asked you a question', since: NOW - 26 * 60_000 },
    { bucket: 'needs-you', reason: 'Needs you', since: NOW - 2 * HOUR },
    { bucket: 'failed', reason: 'Exited with an error', since: NOW - 5 * 60_000 },
    { bucket: 'review', reason: 'Finished, not opened since', since: NOW - 3 * 60_000 },
    { bucket: 'working', reason: 'Running tests', since: NOW - 10_000 },
    { bucket: 'idle', reason: 'Snoozed', since: NOW - HOUR },
    { bucket: 'idle', reason: '', since: null },
  ]
  for (const status of statuses) {
    const s = { ...base, status }
    const card = cardModel(s as never, status.bucket as never, lookup as never, NOW)
    expect(card.status).toBe(statusLine(statusOf(s as never), NOW))
  }
  expect(cardModel({ ...base, status: statuses[0] } as never, 'needs-you', lookup as never, NOW).status).toBe('Needs you 26m · Asked you a question')
  expect(cardModel({ ...base, status: statuses[3] } as never, 'review', lookup as never, NOW).status).toBe('Finished, not opened since 3m')
})
