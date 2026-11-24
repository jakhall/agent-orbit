import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { EDGE_REQUIRED, openWindow } from '../../companion/lib/lifecycle.mjs'

test('without Edge the pop-out opens nothing and says Edge is required (no default-browser fallback)', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-no-edge-'))
  const keys = ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA']
  const saved = keys.map(key => process.env[key])
  try {
    for (const key of keys) process.env[key] = empty
    assert.deepEqual(openWindow(1, 'code'), { isOpened: false, message: EDGE_REQUIRED })
    assert.equal(EDGE_REQUIRED, 'Microsoft Edge is required for the pop-out window.')
  } finally {
    keys.forEach((key, at) => (saved[at] === undefined ? delete process.env[key] : (process.env[key] = saved[at])))
    fs.rmSync(empty, { recursive: true, force: true })
  }
})
