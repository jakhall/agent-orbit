import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { clearData, pruneFiles } from '../../companion/lib/prune.mjs'
import { DATA, FILES } from '../../companion/lib/runtime.mjs'

const OLD = new Date(Date.now() - 30 * 24 * 60 * 60_000)

function outsideFolder(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orbit-prune-${name}-`))
  const file = path.join(dir, 'keep.json')
  fs.writeFileSync(file, '{}')
  fs.utimesSync(file, OLD, OLD)
  return { dir, file }
}

function reset() {
  for (const target of [FILES.sessions, FILES.actions, FILES.inbox, FILES.approvals]) {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) fs.unlinkSync(target)
    else if (stat) {
      for (const name of fs.readdirSync(target)) {
        const inner = path.join(target, name)
        if (fs.lstatSync(inner).isSymbolicLink()) fs.unlinkSync(inner)
      }
      fs.rmSync(target, { recursive: true, force: true })
    }
  }
}

test('prune and clear never follow a link or junction out of the data folder (prune)', () => {
  fs.mkdirSync(DATA, { recursive: true })
  reset()
  const sessions = outsideFolder('sessions')
  const inbox = outsideFolder('inbox')
  const approvals = outsideFolder('approvals')
  const actions = outsideFolder('actions')
  try {
    fs.symlinkSync(sessions.dir, FILES.sessions, 'junction')
    assert.equal(fs.lstatSync(FILES.sessions).isSymbolicLink(), true, 'a junction reads as a link through lstat')
    fs.mkdirSync(FILES.inbox)
    fs.symlinkSync(inbox.dir, path.join(FILES.inbox, 'cli-1'), 'junction')
    fs.mkdirSync(FILES.approvals)
    const approvalLink = path.join(FILES.approvals, '0a1b2c3d-0000-4000-8000-000000000001.json')
    fs.symlinkSync(approvals.dir, approvalLink, 'junction')
    fs.mkdirSync(FILES.actions)
    fs.symlinkSync(actions.dir, path.join(FILES.actions, 'linked'), 'junction')
    const oldAction = path.join(FILES.actions, 'old.json')
    fs.writeFileSync(oldAction, '{}')
    fs.utimesSync(oldAction, OLD, OLD)

    pruneFiles()
    for (const outside of [sessions, inbox, approvals, actions]) assert.equal(fs.existsSync(outside.file), true, `${outside.dir} is untouched by prune`)
    assert.equal(fs.existsSync(oldAction), false, 'a plain old action file is pruned')
    assert.equal(fs.existsSync(approvalLink), true, 'a linked approval entry is left in place')

    const kept = clearData([], { keepFolders: true })
    for (const outside of [sessions, inbox, approvals, actions]) assert.equal(fs.existsSync(outside.file), true, `${outside.dir} is untouched by a window clear`)
    assert.equal(kept.includes('sessions'), false, 'a linked folder is not reported as cleared')

    const removed = clearData([])
    for (const outside of [sessions, inbox, approvals, actions]) assert.equal(fs.existsSync(outside.file), true, `${outside.dir} is untouched by --clear`)
    assert.equal(fs.lstatSync(FILES.sessions).isSymbolicLink(), true, 'the junction itself is left in place')
    assert.equal(removed.includes('sessions'), false)
    assert.equal(fs.existsSync(path.join(FILES.inbox, 'cli-1')), true, 'a folder holding a link keeps the link')
  } finally {
    reset()
    for (const outside of [sessions, inbox, approvals, actions]) fs.rmSync(outside.dir, { recursive: true, force: true })
  }
})

test('clear removes plain folders and files in the data folder (prune)', () => {
  fs.mkdirSync(DATA, { recursive: true })
  reset()
  try {
    fs.mkdirSync(path.join(FILES.inbox, 'cli-2'), { recursive: true })
    fs.writeFileSync(path.join(FILES.inbox, 'cli-2', 'seen.json'), '{}')
    fs.mkdirSync(FILES.sessions, { recursive: true })
    fs.writeFileSync(path.join(FILES.sessions, 'a.json'), '{}')
    fs.writeFileSync(FILES.snapshotV2, '{}')
    const removed = clearData([FILES.snapshotV2])
    assert.deepEqual(removed.slice(0, 3), ['sessions', 'inbox', 'snapshot-v2.json'])
    for (const gone of [FILES.inbox, FILES.sessions, FILES.snapshotV2]) assert.equal(fs.existsSync(gone), false, gone)
  } finally {
    reset()
  }
})
