import assert from 'node:assert/strict'
import test from 'node:test'

import { createLatency, LATENCY_MAX_MS, LATENCY_SAMPLES } from '../../companion/lib/latency.mjs'

test('event to snapshot: a new seq with a watch event behind it is one sample; a timer-only change is none (G-34)', () => {
  const latency = createLatency()
  latency.changed(1, null, 1_000)
  latency.changed(2, 1_000, 1_400)
  const { eventToSnapshotMs } = latency.summary()
  assert.equal(eventToSnapshotMs.samples, 1)
  assert.equal(eventToSnapshotMs.last, 400)
})

test('event to paint: a paint covers every earlier changed seq once; later reports of the same seq add nothing (G-34)', () => {
  const latency = createLatency()
  latency.changed(1, 1_000, 1_300)
  latency.changed(2, 2_000, 2_300)
  latency.changed(3, 3_000, 3_300)
  assert.equal(latency.painted(2, 2_500), 2)
  assert.equal(latency.painted(2, 2_600), 0, 'a second window painting the same seq adds nothing')
  const { eventToPaintMs } = latency.summary()
  assert.equal(eventToPaintMs.samples, 2)
  assert.equal(eventToPaintMs.max, 1_500)
  assert.equal(eventToPaintMs.last, 500)
  assert.equal(latency.painted(3, 3_450), 1)
  assert.equal(latency.summary().eventToPaintMs.last, 450)
})

test('implausible paints are dropped: before the event, or later than the cap (G-34)', () => {
  const latency = createLatency()
  latency.changed(1, 10_000, 10_100)
  assert.equal(latency.painted(1, 9_000), 0)
  latency.changed(2, 20_000, 20_100)
  assert.equal(latency.painted(2, 20_000 + LATENCY_MAX_MS + 1), 0)
  assert.equal(latency.summary().eventToPaintMs.samples, 0)
})

test('the summary keeps the last samples only, with p50, p95 and max (G-34)', () => {
  const latency = createLatency()
  for (let i = 1; i <= LATENCY_SAMPLES + 10; i += 1) latency.changed(i, i * 1_000, i * 1_000 + i)
  const { eventToSnapshotMs } = latency.summary()
  assert.equal(eventToSnapshotMs.samples, LATENCY_SAMPLES)
  assert.equal(eventToSnapshotMs.max, LATENCY_SAMPLES + 10)
  assert.equal(eventToSnapshotMs.last, LATENCY_SAMPLES + 10)
  assert.equal(eventToSnapshotMs.p50, 11 + Math.floor(LATENCY_SAMPLES / 2))
  assert.deepEqual(createLatency().summary().eventToPaintMs, { samples: 0, last: null, p50: null, p95: null, max: null })
})
