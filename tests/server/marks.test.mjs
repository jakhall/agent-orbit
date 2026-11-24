import assert from 'node:assert/strict'
import test from 'node:test'

import { withPersonMarks } from '../../shared/aggregate/status.js'
import { applyMarks, sanitizePrefs } from '../../shared/prefs.js'
import { donePatch, snoozePatch } from '../../shared/popout.js'

const NOW = 1_800_000_000_000
const KEY = 'local_0a1b2c3d-0000-4000-8000-000000000001'
const session = (patch = {}) => ({ key: KEY, stateSince: NOW - 600_000, finishedAt: NOW - 600_000, ...patch })
const need = since => ({ bucket: 'needs-you', reason: 'Asked you a question', since, isObserved: true })
const review = { bucket: 'review', reason: 'Finished 10m ago', since: NOW - 600_000, isObserved: true }

test('Done takes a session out of Needs you and Review until it has new activity after the mark (C6)', () => {
  const marks = { done: { [KEY]: NOW - 60_000 }, snoozed: {} }
  assert.deepEqual(withPersonMarks(need(NOW - 120_000), session(), marks, NOW), { bucket: 'idle', reason: 'Done', since: NOW - 60_000, isObserved: false, isDone: true, snoozedUntil: null })
  assert.equal(withPersonMarks(review, session(), marks, NOW).isDone, true)
  assert.deepEqual(withPersonMarks(need(NOW - 30_000), session(), marks, NOW).bucket, 'needs-you', 'a new need after Done brings it back')
  assert.equal(withPersonMarks(review, session({ stateSince: NOW - 10_000 }), marks, NOW).bucket, 'review', 'a new turn after Done brings it back')
  assert.equal(withPersonMarks(review, session(), { done: {}, snoozed: {} }, NOW).isDone, false)
})

test('Snooze hides a need until its time, and a new need arrives through it (C6)', () => {
  const marks = { done: {}, snoozed: { [KEY]: { until: NOW + 30 * 60_000, at: NOW - 60_000 } } }
  assert.deepEqual(withPersonMarks(need(NOW - 120_000), session(), marks, NOW), { bucket: 'idle', reason: 'Snoozed', since: NOW - 60_000, isObserved: false, isDone: false, snoozedUntil: NOW + 30 * 60_000 })
  assert.equal(withPersonMarks(review, session(), marks, NOW).bucket, 'idle')
  assert.deepEqual([withPersonMarks(need(NOW - 10_000), session(), marks, NOW).bucket, withPersonMarks(need(NOW - 10_000), session(), marks, NOW).snoozedUntil], ['needs-you', null], 'a question or permission after the snooze comes through')
  const working = { bucket: 'working', reason: 'Running tests', since: NOW - 5_000, isObserved: true }
  assert.deepEqual(withPersonMarks(working, session(), marks, NOW), { ...working, isDone: false, snoozedUntil: NOW + 30 * 60_000 }, 'a working session keeps its bucket and shows the snooze')
  assert.equal(withPersonMarks(need(NOW - 120_000), session(), marks, NOW + 31 * 60_000).bucket, 'needs-you', 'after its time the need is back')
})

test('prefs keep done and snoozed marks as numbers, at most 500 each, newest kept (C6)', () => {
  const raw = {
    done: { [KEY]: NOW, bad: 'x', __proto__: 1, neg: -5 },
    snoozed: { [KEY]: { until: NOW + 1_000, at: NOW }, backwards: { until: NOW, at: NOW + 1 }, bare: NOW },
  }
  const clean = sanitizePrefs(JSON.parse(JSON.stringify(raw)))
  assert.deepEqual(clean.done, { [KEY]: NOW })
  assert.deepEqual(clean.snoozed, { [KEY]: { until: NOW + 1_000, at: NOW } })
  const many = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`k${i}`, NOW + i]))
  const capped = sanitizePrefs({ done: many }).done
  assert.equal(Object.keys(capped).length, 500)
  assert.equal(capped.k599, NOW + 599)
  assert.equal(capped.k0, undefined)
})

test('applyMarks merges the page’s Done and Snooze patches (null clears) and replaces the hidden map, for the server and the pane alike (C6)', () => {
  const OTHER = 'local_0a1b2c3d-0000-4000-8000-000000000002'
  const start = { done: { [OTHER]: NOW - 5 }, snoozed: {}, hidden: { [OTHER]: NOW - 9 } }
  const done = applyMarks(start, donePatch(KEY, NOW))
  assert.deepEqual(done.done, { [OTHER]: NOW - 5, [KEY]: NOW })
  assert.deepEqual(applyMarks(done, donePatch(KEY, null)).done, { [OTHER]: NOW - 5 })
  const snoozed = applyMarks(start, snoozePatch(KEY, NOW + 3_600_000, NOW))
  assert.deepEqual(snoozed.snoozed, { [KEY]: { until: NOW + 3_600_000, at: NOW } })
  assert.deepEqual(applyMarks(snoozed, snoozePatch(KEY, null, NOW)).snoozed, {})
  assert.deepEqual(applyMarks(start, { hidden: { [KEY]: NOW } }).hidden, { [KEY]: NOW })
  assert.deepEqual(applyMarks(start, { done: { __proto__: null, ['x'.repeat(601)]: NOW } }).done, start.done, 'an over-long key is ignored')
  assert.equal(applyMarks(start, {}), start, 'a patch without marks changes nothing')
})
