import assert from 'node:assert/strict'
import test from 'node:test'

import { stateAnswer } from '../../companion/lib/state.mjs'

const files = { snapshot: 'snapshot.json', prefs: 'prefs.json' }

function fakeFolder() {
  const disk = { 'snapshot.json': { text: '{"v":1}', mtime: 100 }, 'prefs.json': { text: '{"p":1}', mtime: 50 } }
  return {
    disk,
    takeStamps: () => ({ snapshot: disk['snapshot.json'].mtime, prefs: disk['prefs.json'].mtime }),
  }
}

test('a stamp is never newer than the snapshot it came with (E-92)', async () => {
  const { disk, takeStamps } = fakeFolder()
  const readText = async file => {
    const text = disk[file].text
    if (file === 'prefs.json') disk['snapshot.json'] = { text: '{"v":2}', mtime: 200 }
    return text
  }
  const body = JSON.parse(await stateAnswer({ readText, takeStamps, files, wantsSnapshot: false }))
  assert.equal(body.snapshot, null)
  assert.equal(body.stamps.snapshot, 100, 'a prefs-only answer must not claim the snapshot written during the read')
})

test('the snapshot and its stamp match when nothing changes meanwhile', async () => {
  const { disk, takeStamps } = fakeFolder()
  const body = JSON.parse(await stateAnswer({ readText: async file => disk[file].text, takeStamps, files, wantsSnapshot: true }))
  assert.deepEqual(body, { snapshot: { v: 1 }, prefs: { p: 1 }, stamps: { snapshot: 100, prefs: 50 } })
})

test('an unreadable or half-written file answers null', async () => {
  const { takeStamps } = fakeFolder()
  const readText = async file => {
    if (file === 'snapshot.json') throw new Error('EBUSY')
    return '{"p":'
  }
  const body = JSON.parse(await stateAnswer({ readText, takeStamps, files, wantsSnapshot: true }))
  assert.equal(body.snapshot, null)
  assert.equal(body.prefs, null)
})
