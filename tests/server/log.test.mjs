import assert from 'node:assert/strict'
import test from 'node:test'

import { errorWhere } from '../../companion/lib/log.mjs'

test('an internal error is logged as its name and the first own frame, file:line, never its message or a full path (E-30)', () => {
  const error = new TypeError('secret prompt text C:\\Users\\jak\\repo')
  error.stack = [
    'TypeError: secret prompt text C:\\Users\\jak\\repo',
    '    at JSON.parse (<anonymous>)',
    '    at readThing (node:internal/fs/promises:1:1)',
    '    at changes (file:///C:/Users/jak/Nodes/companion/server.mjs:917:11)',
    '    at checkoutChanges (file:///C:/Users/jak/Nodes/shared/changes.js:40:3)',
  ].join('\n')
  assert.equal(errorWhere(error), 'TypeError at server.mjs:917')
  assert.equal(errorWhere(Object.assign(new Error('x'), { stack: 'Error: x\n    at node:internal/x:1:1' })), 'Error')
  assert.equal(errorWhere('not an error'), 'Error')
})
