import assert from 'node:assert/strict'
import test from 'node:test'

import { createNotices, NOTICE_TTL_MS } from '../../companion/lib/notices.mjs'

const NOW = 1_800_000_000_000
const snap = sessions => ({ sessions })
const s = (key, bucket, since, extra = {}) => ({ key, cliSessionId: `cli-${key}`, title: `Session ${key}`, status: { bucket, reason: bucket === 'needs-you' ? 'Asked you a question' : bucket === 'failed' ? 'Claude could not start' : 'Finished 1m ago', since, isObserved: true, isDone: false, snoozedUntil: null }, ...extra })

function setup(mode = 'needs-you') {
  let at = NOW
  const notices = createNotices({ now: () => at })
  const observe = (sessions, options = {}) => notices.observe(snap(sessions), { mode, isAttentive: false, ...options })
  return { notices, observe, tick: ms => (at += ms) }
}

test('the first look is a baseline: needs that were already there raise nothing (G-20)', () => {
  const { notices, observe } = setup()
  observe([s('a', 'needs-you', NOW - 10_000)])
  assert.deepEqual(notices.pendingFor('cli-x'), [])
})

test('a new need and a new failure raise one notice each, once; a finished turn only in mode all (G-20, G-21)', () => {
  const { notices, observe, tick } = setup()
  observe([s('a', 'idle', NOW - 60_000), s('b', 'idle', NOW - 60_000), s('c', 'working', NOW - 60_000)])
  tick(1_000)
  observe([s('a', 'needs-you', NOW + 500), s('b', 'failed', NOW + 600), s('c', 'review', NOW + 700)])
  observe([s('a', 'needs-you', NOW + 500), s('b', 'failed', NOW + 600), s('c', 'review', NOW + 700)])
  const pending = notices.pendingFor('cli-x')
  assert.deepEqual(pending.map(n => [n.sessionKey, n.kind, n.title, n.body]), [
    ['a', 'needs-you', 'Needs you · Session a', 'Asked you a question'],
    ['b', 'failed', 'Failed · Session b', 'Claude could not start'],
  ])
  const all = setup('all')
  all.observe([s('c', 'working', NOW - 60_000)])
  all.tick(1_000)
  all.observe([s('c', 'review', NOW + 700)])
  assert.deepEqual(all.notices.pendingFor('cli-x').map(n => n.kind), ['review'])
})

test('one session claims each notice; it expires unclaimed after its time (G-20)', () => {
  const { notices, observe, tick } = setup()
  observe([s('a', 'idle', NOW - 60_000)])
  tick(1_000)
  observe([s('a', 'needs-you', NOW + 500)])
  const [notice] = notices.pendingFor('cli-1')
  assert.equal(notices.claim(notice.id, 'cli-1').ok, true)
  assert.equal(notices.claim(notice.id, 'cli-2').ok, false)
  assert.deepEqual(notices.pendingFor('cli-2'), [])
  observe([s('a', 'idle', NOW + 2_000)])
  tick(1_000)
  observe([s('a', 'needs-you', NOW + 3_000)])
  tick(NOTICE_TTL_MS + 1)
  assert.deepEqual(notices.pendingFor('cli-1'), [], 'stale notices are not handed out')
})

test('nothing is raised while muted, or for Done and snoozed sessions (they are not in Needs you)', () => {
  const muted = setup('off')
  muted.observe([s('a', 'idle', NOW - 60_000)])
  muted.tick(1_000)
  assert.deepEqual(muted.observe([s('a', 'needs-you', NOW + 500)]), [])
  assert.deepEqual(muted.notices.pendingFor('cli-x'), [])
})

test('while the person is looking a notice is quiet: a window may show it as a banner, a mod never raises it', () => {
  const looking = setup()
  looking.observe([s('a', 'idle', NOW - 60_000)])
  looking.tick(1_000)
  const [quiet] = looking.observe([s('a', 'needs-you', NOW + 500)], { isAttentive: true })
  assert.deepEqual([quiet.isQuiet, quiet.label, quiet.sessionTitle, quiet.body], [true, 'Needs you', 'Session a', 'Asked you a question'])
  looking.tick(1_000)
  assert.deepEqual(looking.observe([s('a', 'needs-you', NOW + 500)]), [], 'a need seen while the person was looking is not raised again')
  assert.deepEqual(looking.notices.pendingFor(), [])
  assert.equal(looking.notices.claim(quiet.id, 'cli-1').ok, false, 'a mod cannot claim a quiet notice')
  assert.equal(looking.notices.claim(quiet.id, 'window:w1').ok, true)
  assert.deepEqual(looking.notices.stats(), { raised: 1, claimed: 1, quiet: 1 })
})

test('an open window gets the first chance; a mod takes a notice it left unclaimed for 5 s', () => {
  const { notices, observe, tick } = setup()
  observe([s('a', 'idle', NOW - 60_000), s('b', 'idle', NOW - 60_000)])
  tick(1_000)
  const raised = observe([s('a', 'needs-you', NOW + 500), s('b', 'failed', NOW + 600)])
  assert.deepEqual(raised.map(n => [n.sessionKey, n.isQuiet]), [['a', false], ['b', false]], 'observe returns the new notices for pushing to windows')
  assert.deepEqual(notices.pendingFor({ hasWindow: true }), [])
  assert.equal(notices.pendingFor().length, 2, 'with no window open the mods may take them at once')
  assert.equal(notices.claim(raised[0].id, 'window:w1').ok, true)
  tick(5_000)
  assert.deepEqual(notices.pendingFor({ hasWindow: true }).map(n => n.sessionKey), ['b'])
})

test('at most one notice per session a minute (G-21)', () => {
  const { notices, observe, tick } = setup()
  observe([s('a', 'idle', NOW - 60_000)])
  tick(1_000)
  observe([s('a', 'needs-you', NOW + 500)])
  tick(5_000)
  observe([s('a', 'needs-you', NOW + 5_500)])
  assert.equal(notices.pendingFor('cli-x').length, 1)
})
