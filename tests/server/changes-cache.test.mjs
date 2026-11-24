import assert from 'node:assert/strict'
import test from 'node:test'

import { canReuseChanges } from '../../companion/lib/changes-cache.mjs'

const NOW = 1_800_000_000_000
const session = { cwd: 'C:\\repo', lastActivityAt: NOW - 120_000 }

test('a Changes answer is reused for 45 s while the session has not moved (E-115)', () => {
  const cached = { at: NOW - 30_000, cwd: 'C:\\repo', state: 'ok' }
  assert.equal(canReuseChanges(cached, session, NOW, false), true)
  assert.equal(canReuseChanges({ ...cached, at: NOW - 46_000 }, session, NOW, false), false)
  assert.equal(canReuseChanges(cached, { ...session, lastActivityAt: NOW - 1_000 }, NOW, false), false, 'activity after the answer')
  assert.equal(canReuseChanges(cached, session, NOW, true), false, 'the page asked for a fresh answer')
  assert.equal(canReuseChanges(cached, { ...session, cwd: 'C:\\other' }, NOW, false), false)
  assert.equal(canReuseChanges(null, session, NOW, false), false)
})

test('a repository that timed out is not asked again for 2 minutes, even on request (E-115)', () => {
  const timedOut = { at: NOW - 60_000, cwd: 'C:\\repo', state: 'timeout' }
  assert.equal(canReuseChanges(timedOut, { ...session, lastActivityAt: NOW }, NOW, true), true)
  assert.equal(canReuseChanges({ ...timedOut, at: NOW - 121_000 }, session, NOW, false), false)
})
