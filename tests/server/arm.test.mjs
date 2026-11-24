import assert from 'node:assert/strict'
import test from 'node:test'

import { CAPABILITIES, createArm } from '../../companion/lib/arm.mjs'

function store(files = {}) {
  const data = new Map(Object.entries(files))
  return {
    data,
    read: name => (data.has(name) ? data.get(name) : null),
    write: (name, text) => void data.set(name, text),
  }
}

test('every capability is off by default and arming is per capability (D-6)', () => {
  const s = store()
  const arm = createArm({ ...s, now: () => 1_000 })
  assert.deepEqual(CAPABILITIES, ['approvals', 'questions', 'replies'])
  for (const c of CAPABILITIES) assert.equal(arm.isArmed(c), false, c)
  arm.set('replies', true)
  assert.equal(arm.isArmed('replies'), true)
  assert.equal(arm.isArmed('approvals'), false)
  assert.deepEqual(arm.view().replies, { armed: true, at: 1_000, source: 'window' })
  assert.throws(() => arm.set('launches', true))
})

test('the state survives a restart through arm.json, and a tampered file arms nothing and is reported (D-6)', () => {
  const s = store()
  createArm({ ...s, now: () => 1 }).set('approvals', true)
  assert.equal(createArm({ ...s, now: () => 2 }).isArmed('approvals'), true)
  const forged = JSON.parse(s.data.get('arm.json'))
  forged.state.replies = { armed: true, at: 3, source: 'window' }
  s.write('arm.json', JSON.stringify(forged))
  const reloaded = createArm({ ...s, now: () => 4 })
  assert.equal(reloaded.isArmed('replies'), false)
  assert.equal(reloaded.isArmed('approvals'), false, 'a file that fails its check arms nothing')
  assert.equal(reloaded.tampered, true)
})

test("An existing Approve from Orbit = on counts as an explicit arm of approvals and questions, once; off stays off (D-6 migration)", () => {
  const on = store({ 'approvals/enabled.json': JSON.stringify({ enabled: true, at: 5 }) })
  const migrated = createArm({ ...on, now: () => 10 })
  assert.equal(migrated.isArmed('approvals'), true)
  assert.equal(migrated.isArmed('questions'), true)
  assert.equal(migrated.isArmed('replies'), false)
  assert.equal(migrated.view().approvals.source, 'migrated')
  migrated.set('approvals', false)
  assert.equal(createArm({ ...on, now: () => 11 }).isArmed('approvals'), false, 'never re-armed by the old file once arm.json exists')
  const off = store({ 'approvals/enabled.json': JSON.stringify({ enabled: false }) })
  assert.equal(createArm({ ...off, now: () => 12 }).isArmed('approvals'), false)
})

test('a missing arm.json beside its key is tampering, not a first start; the old switch migrates only on a first start (review)', () => {
  const s = store()
  createArm({ ...s, now: () => 1 }).set('approvals', true)
  s.data.delete('arm.json')
  s.write('approvals/enabled.json', JSON.stringify({ enabled: true }))
  const reloaded = createArm({ ...s, now: () => 2 })
  assert.equal(reloaded.tampered, true)
  assert.equal(reloaded.isArmed('approvals'), false, 'deleting arm.json and writing enabled.json arms nothing')
  assert.deepEqual(createArm({ ...store(), now: () => 3 }).restored(), [], 'nothing restored on a first start')
  const kept = store()
  createArm({ ...kept, now: () => 4 }).set('replies', true)
  assert.deepEqual(createArm({ ...kept, now: () => 5 }).restored(), ['replies'], 'what a restart re-arms is reported, for the audit record')
})
