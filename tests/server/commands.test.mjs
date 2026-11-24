import assert from 'node:assert/strict'
import test from 'node:test'

import { createCommandStore } from '../../companion/lib/commands.mjs'

const NOW = 1_800_000_000_000

test('a published command list keeps allowed, unique names with short one-line descriptions and known sources', () => {
  const store = createCommandStore({ now: () => NOW })
  assert.equal(store.set('cli-1', { commands: 'nope' }), false)
  assert.equal(store.set('cli-1', null), false)
  assert.equal(store.set('cli-1', { commands: [
    { name: 'compact', description: '  Clear   history\n keep a summary ', source: 'builtin' },
    { name: 'compact', description: 'again', source: 'builtin' },
    { name: 'config', description: 'settings', source: 'builtin' },
    { name: 'bad name', description: '', source: 'user' },
    { name: 'review', description: 'x'.repeat(300), source: 'weird' },
    null,
  ] }), true)
  const list = store.listFor('cli-1')
  assert.deepEqual(list.map(c => c.name), ['compact', 'review'])
  assert.equal(list[0].description, 'Clear history keep a summary')
  assert.equal(list[1].description.length, 120)
  assert.equal(list[1].source, 'builtin')
  assert.deepEqual([...store.namesFor('cli-1')], ['compact', 'review'])
  assert.equal(store.listFor('cli-2'), null)
})

test('a list older than ten minutes reads as gone, and at most 200 sessions are kept, the least recently published dropped first', () => {
  let now = NOW
  const store = createCommandStore({ now: () => now })
  store.set('cli-old', { commands: [{ name: 'compact' }] })
  now += 10 * 60_000
  assert.notEqual(store.listFor('cli-old'), null)
  now += 1
  assert.equal(store.listFor('cli-old'), null)
  assert.equal(store.namesFor('cli-old'), null)
  for (let i = 0; i < 201; i++) store.set(`cli-${i}`, { commands: [] })
  assert.equal(store.listFor('cli-0'), null)
  assert.deepEqual(store.listFor('cli-200'), [])
})
