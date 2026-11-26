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

test('a plugin command keeps its plugin name when it is a plain name; other sources never carry one', () => {
  const store = createCommandStore({ now: () => NOW })
  store.set('cli-1', { commands: [
    { name: 'agent-toolbox:tb-lean', description: 'Lean', source: 'plugin', plugin: 'agent-toolbox' },
    { name: 'odd', source: 'plugin', plugin: '../escape' },
    { name: 'mine', source: 'user', plugin: 'agent-toolbox' },
  ] })
  assert.deepEqual(store.listFor('cli-1'), [
    { name: 'agent-toolbox:tb-lean', description: 'Lean', source: 'plugin', plugin: 'agent-toolbox' },
    { name: 'odd', description: '', source: 'plugin' },
    { name: 'mine', description: '', source: 'user' },
  ])
})

test('the catalog lists every fresh session\'s commands once, newest description first, with how many sessions list each', () => {
  let now = NOW
  const store = createCommandStore({ now: () => now })
  store.set('cli-gone', { commands: [{ name: 'gone', source: 'user' }] })
  now += 10 * 60_000 + 1
  store.set('cli-1', { commands: [{ name: 'review', description: 'old', source: 'user' }, { name: 'compact', source: 'builtin' }] })
  store.set('cli-2', { commands: [{ name: 'review', description: 'new', source: 'user' }] })
  assert.deepEqual(store.catalog(), [
    { name: 'compact', description: '', source: 'builtin', sessions: 1 },
    { name: 'review', description: 'new', source: 'user', sessions: 2 },
  ])
  assert.deepEqual(createCommandStore().catalog(), [])
})
