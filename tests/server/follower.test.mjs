import assert from 'node:assert/strict'
import test from 'node:test'

import { createTranscriptFollower } from '../../companion/lib/follower.mjs'

function harness(paths = { 'local_a': 'A.jsonl', 'local_b': 'B.jsonl' }) {
  const watchers = new Map()
  const sent = []
  const follower = createTranscriptFollower({
    resolve: async key => paths[key] ?? null,
    watch: (file, onChange) => {
      watchers.set(file, onChange)
      return () => watchers.delete(file)
    },
    send: (windowId, key) => sent.push([windowId, key]),
    debounceMs: 0,
  })
  const settle = () => new Promise(r => setTimeout(r, 5))
  return { follower, watchers, sent, settle }
}

test('a window follows its selected session: a transcript write sends one conversation event to that window (E-110)', async () => {
  const { follower, watchers, sent, settle } = harness()
  await follower.follow('w1', 'local_a')
  assert.deepEqual([...watchers.keys()], ['A.jsonl'])
  watchers.get('A.jsonl')()
  watchers.get('A.jsonl')()
  await settle()
  assert.deepEqual(sent, [['w1', 'local_a']])
})

test('changing or clearing the selection moves or drops the watch; a closed window drops it (E-110)', async () => {
  const { follower, watchers, settle } = harness()
  await follower.follow('w1', 'local_a')
  await follower.follow('w1', 'local_a')
  assert.deepEqual([...watchers.keys()], ['A.jsonl'])
  await follower.follow('w1', 'local_b')
  assert.deepEqual([...watchers.keys()], ['B.jsonl'])
  await follower.follow('w1', null)
  assert.deepEqual([...watchers.keys()], [])
  await follower.follow('w2', 'local_a')
  follower.stop('w2')
  await settle()
  assert.deepEqual([...watchers.keys()], [])
})

test('a session without a transcript watches nothing; two windows on one session share nothing between them (E-110)', async () => {
  const { follower, watchers, sent, settle } = harness()
  await follower.follow('w1', 'local_none')
  assert.equal(watchers.size, 0)
  await follower.follow('w1', 'local_a')
  await follower.follow('w2', 'local_b')
  watchers.get('B.jsonl')()
  await settle()
  assert.deepEqual(sent, [['w2', 'local_b']])
  assert.equal(follower.size(), 2)
})
