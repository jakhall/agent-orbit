import assert from 'node:assert/strict'
import test from 'node:test'

import { AUDIT_MAX_BYTES, auditLine, createAudit, forgedKind } from '../../companion/lib/audit.mjs'

test('audit lines keep allow-listed short fields only, never text (E-22)', () => {
  const line = auditLine({ kind: 'approval', id: '0a1b2c3d-0000-4000-8000-0000000000a1', session: '0a1b2c3d-0000-4000-8000-00000000c4a6', tool: 'Bash', inputHash: 'a'.repeat(64), outcome: 'answered: allow', text: 'SECRET prompt', toolInput: { command: 'rm x' } }, 5)
  assert.deepEqual(line, { at: 5, kind: 'approval', id: '0a1b2c3d-0000-4000-8000-0000000000a1', session: '0a1b2c3d-0000-4000-8000-00000000c4a6', tool: 'Bash', inputHash: 'a'.repeat(64), outcome: 'answered: allow' })
  assert.equal(auditLine({ kind: 'note', what: 'x' }, 1), null)
  assert.equal(auditLine({ kind: 'reply', outcome: 'SECRET: words; with punctuation!' }, 1)?.outcome, undefined, 'free text is dropped')
  assert.equal(auditLine({ kind: 'approval', inputHash: 'not-a-hash' }, 1)?.inputHash, undefined)
})

test('the record appends, rotates once past 1 MB, and reads newest first (E-22)', () => {
  let current = ''
  let previous = ''
  let rotations = 0
  const audit = createAudit({
    append: text => (current += text),
    size: () => current.length,
    rotate: () => {
      previous = current
      current = ''
      rotations += 1
    },
    read: () => [previous, current],
    now: () => 7,
  })
  audit.record({ kind: 'arm', capability: 'replies', armed: true })
  audit.record({ kind: 'alert', where: 'inbox', what: 'request' })
  assert.deepEqual(audit.recent(10).map(l => l.kind), ['alert', 'arm'])
  current += 'x'.repeat(AUDIT_MAX_BYTES + 1)
  audit.record({ kind: 'arm', capability: 'replies', armed: false })
  assert.equal(rotations, 1)
  assert.equal(audit.recent(1)[0].armed, false)
})

test('forged files: approval requests and answers, inbox requests; acknowledgements and seen.json are left alone (A5)', () => {
  const id = '0a1b2c3d-0000-4000-8000-0000000000a1'
  assert.equal(forgedKind('approvals', `${id}.json`), 'request')
  assert.equal(forgedKind('approvals', `${id}.answer.json`), 'answer')
  assert.equal(forgedKind('approvals', 'enabled.json'), null)
  assert.equal(forgedKind('inbox', `${id}.json`), 'request')
  assert.equal(forgedKind('inbox', `${id}.ack.json`), null)
  assert.equal(forgedKind('inbox', 'seen.json'), null)
})

test('audit lines record stops and the sub-agent they were for', () => {
  const line = auditLine({ kind: 'stop', id: '0a1b2c3d-0000-4000-8000-0000000000a1', session: '0a1b2c3d-0000-4000-8000-00000000c4a6', agent: 'agent-a1', outcome: 'stopped', text: 'SECRET' }, 5)
  assert.deepEqual(line, { at: 5, kind: 'stop', id: '0a1b2c3d-0000-4000-8000-0000000000a1', session: '0a1b2c3d-0000-4000-8000-00000000c4a6', agent: 'agent-a1', outcome: 'stopped' })
})
