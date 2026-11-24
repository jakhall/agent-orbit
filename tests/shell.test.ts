import { expect, test } from 'claude-code/testing'

import { armedCapabilities, shellSendBlock, shellState, type ShellInput } from '../shared/popout.js'

const T = 1_700_000_000_000
const live: ShellInput = { now: T, connected: true, droppedAt: null, isClosed: false, retriedAt: null, hasSnapshot: true, problem: null, acceptedAt: T - 5_000, generatedAt: T - 600_000, checkedAt: T - 5_000, isLoading: false, loadFailures: 0, isPaused: false }

test('a live window shows no banner and may send, however long the data has not changed', () => {
  expect(shellState(live)).toEqual({ kind: 'ok', text: '', action: null, blocksSending: false, isAlert: false })
})

test('review B1 row 3: a refused token or a closed stream means this window’s link expired; no Retry is offered because none can work', () => {
  expect(shellState({ ...live, isClosed: true })).toEqual({ kind: 'expired', text: 'Orbit restarted, so this window’s link expired. Use Pop out in the Orbit pane to open a new one.', action: null, blocksSending: true, isAlert: true })
})

test('review B1 row 3: an unreachable server keeps Retry and says when it was last tried', () => {
  const down = { ...live, connected: false, droppedAt: T - 20_000 }
  expect(shellState(down)).toEqual({ kind: 'server-gone', text: 'Can’t reach Orbit. If it restarted, use Pop out in the Orbit pane.', action: 'retry', blocksSending: true, isAlert: true })
  const tried = new Date(2023, 10, 14, 14, 2).getTime()
  expect(shellState({ ...down, retriedAt: tried }).text).toBe('Can’t reach Orbit. If it restarted, use Pop out in the Orbit pane. Last tried 14:02.')
})

test('a dropped stream shows "Reconnecting" after 3 s and blocks sending; under 3 s nothing shows yet', () => {
  expect(shellState({ ...live, connected: false, droppedAt: T - 2_999 }).kind).toBe('ok')
  expect(shellState({ ...live, connected: false, droppedAt: T - 3_000 })).toEqual({ kind: 'reconnecting', text: 'Reconnecting to Orbit…', action: 'retry', blocksSending: true, isAlert: false })
})

test('before the first answer: loading; after three failed loads it says so with Retry; with no snapshot on the server: no sessions yet', () => {
  const empty = { ...live, hasSnapshot: false, acceptedAt: null, generatedAt: null }
  expect(shellState({ ...empty, isLoading: true }).kind).toBe('loading')
  expect(shellState({ ...empty, isLoading: true, loadFailures: 3 })).toEqual({ kind: 'load-failed', text: 'Can’t load sessions from Orbit.', action: 'retry', blocksSending: false, isAlert: false })
  expect(shellState({ ...empty, problem: 'Waiting for data from a Claude session…' })).toEqual({ kind: 'no-data', text: 'No sessions yet: start a Claude desktop session with Orbit.', action: 'new-desktop', blocksSending: false, isAlert: false })
})

test('switch: data is stale once the server has not confirmed it (checkedAt) for 2 minutes, however long it has not changed', () => {
  expect(shellState({ ...live, checkedAt: T - 119_999 }).kind).toBe('ok')
  expect(shellState({ ...live, checkedAt: T - 120_000 })).toEqual({ kind: 'stale', text: 'Not updated for 2m: Orbit stopped checking for changes.', action: 'retry', blocksSending: true, isAlert: false })
  expect(shellState({ ...live, checkedAt: T - 300_000 }).text).toBe('Not updated for 5m: Orbit stopped checking for changes.')
  expect(shellState({ ...live, checkedAt: null, generatedAt: T - 300_000 }).kind).toBe('stale')
  expect(shellState({ ...live, checkedAt: null, generatedAt: T - 60_000 }).kind).toBe('ok')
})

test('switch: "not live" comes from /api/health, never from a leader: not watching, or its short error phrases', () => {
  const watching = { isWatching: true, isPaused: false, errors: [] }
  expect(shellState({ ...live, health: watching }).kind).toBe('ok')
  expect(shellState({ ...live, health: { ...watching, isWatching: false } })).toEqual({ kind: 'not-live', text: 'Not live: Orbit is not watching the session files.', action: 'retry', blocksSending: false, isAlert: false })
  expect(shellState({ ...live, health: { ...watching, errors: ['aggregation failed: TypeError'] } })).toEqual({ kind: 'not-live', text: 'Not live: aggregation failed: TypeError.', action: 'retry', blocksSending: false, isAlert: false })
  expect(shellState({ ...live, health: null }).kind).toBe('ok')
  expect(shellState({ ...live, checkedAt: T - 300_000, health: { ...watching, isWatching: false } }).kind).toBe('stale')
})

test('switch: the server pausing aggregation (health.isPaused) shows the paused state like the shared setting does', () => {
  expect(shellState({ ...live, health: { isWatching: true, isPaused: true, errors: [] } }).kind).toBe('paused')
})

test('review B1 row 4: paused updates say so with Resume, and still pause sending once the data is old', () => {
  expect(shellState({ ...live, isPaused: true, checkedAt: T - 100_000 })).toEqual({ kind: 'paused', text: 'Live updates are paused.', action: 'resume', blocksSending: false, isAlert: false })
  expect(shellState({ ...live, isPaused: true, checkedAt: T - 300_000 })).toEqual({ kind: 'paused', text: 'Live updates are paused. This data is 5m old.', action: 'resume', blocksSending: true, isAlert: false })
})

test('review B1 row 4: a refused snapshot is a banner, and pauses sending once the data shown is 2 minutes old', () => {
  const problem = 'Snapshot format 2 is newer than this window. Reopen it after updating Orbit. Showing the last one.'
  expect(shellState({ ...live, problem })).toEqual({ kind: 'rejected', text: problem, action: 'retry', blocksSending: false, isAlert: false })
  expect(shellState({ ...live, problem, acceptedAt: T - 120_000 }).blocksSending).toBe(true)
})

test('priority: expired, unreachable, reconnecting, then loading and no data, then a refused snapshot, then paused, stale or not live', () => {
  const all: ShellInput = { ...live, isClosed: true, connected: false, droppedAt: T - 5_000, problem: 'x', checkedAt: T - 300_000, isPaused: true }
  expect(shellState(all).kind).toBe('expired')
  expect(shellState({ ...all, isClosed: false }).kind).toBe('reconnecting')
  expect(shellState({ ...all, isClosed: false, connected: true, droppedAt: null }).kind).toBe('rejected')
  expect(shellState({ ...all, isClosed: false, connected: true, droppedAt: null, problem: null }).kind).toBe('paused')
})

test('while the shell state blocks sending, the composer says why in a few words', () => {
  expect(shellSendBlock(shellState(live))).toBe(null)
  expect(shellSendBlock(shellState({ ...live, checkedAt: T - 300_000 }))).toEqual({ short: 'Sending paused: this data is out of date.', text: 'Not updated for 5m: Orbit stopped checking for changes.' })
  expect(shellSendBlock(shellState({ ...live, connected: false, droppedAt: T - 5_000 }))?.short).toBe('Sending paused: reconnecting to Orbit.')
  expect(shellSendBlock(shellState({ ...live, isClosed: true }))?.short).toBe('Sending paused: Orbit is not reachable.')
  expect(shellSendBlock(shellState({ ...live, checkedAt: T - 100_000 }))).toBe(null)
})

test('review B1 row 9: an armed capability chip opens its own switch and says what it does', () => {
  expect(armedCapabilities({ approvals: true, questions: false, replies: false })).toEqual([
    { key: 'approvals', label: 'Approvals', control: 's-arm-approvals', title: 'Permission prompts wait in Orbit first while you use a window. Opens the switch.' },
  ])
})

test('C9 review N2: a source Orbit cannot read leaves the map live, with a note; only a failed aggregation or no watching is not live', () => {
  const watching = { isWatching: true, isPaused: false, errors: ['some sources unreadable'] }
  expect(shellState({ ...live, health: watching })).toEqual({ kind: 'partial', text: 'Live, but some sources unreadable.', action: null, blocksSending: false, isAlert: false })
})
