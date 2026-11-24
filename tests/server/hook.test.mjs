import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('the approval hook takes its data folder only from --data, never from the environment (E-42)', () => {
  const source = fs.readFileSync(new URL('../../hooks/approve.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /process\.env\.ORBIT_DATA_DIR/)
})
