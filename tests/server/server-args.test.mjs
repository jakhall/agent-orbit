import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { parseArgs } from '../../companion/server.mjs'

const env = { USERPROFILE: 'C:\Users\t' }

test('the server can be imported without starting anything, and reads its command line without side effects (E-33)', () => {
  const plain = parseArgs([], env)
  assert.equal(plain.ok, true)
  assert.equal(plain.opts.mode, '')
  assert.equal(plain.opts.data, path.join('C:\Users\t', '.claude', 'orbit'))
  const daemon = parseArgs(['--launch', '--no-window', '--dry-run', '--data', 'D'], env)
  assert.deepEqual([daemon.opts.mode, daemon.opts.noWindow, daemon.opts.dryRun, daemon.opts.data], ['launch', true, true, 'D'])
  assert.deepEqual(parseArgs(['--serve', '--dry-run'], env), { ok: false, message: '--dry-run needs its own --data folder' })
  assert.deepEqual(parseArgs(['--serve', '--projects', 'P'], env), { ok: false, message: '--projects and --desktop are for tests and need --dry-run' })
  assert.equal(parseArgs(['--serve', '--dry-run', '--data', 'D', '--projects', 'P'], env).opts.isProjectsGiven, true)
  assert.equal(parseArgs(['--made-up', '--serve'], env).opts.mode, 'serve', 'unknown flags are ignored')
})
