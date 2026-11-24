import fs from 'node:fs'
import path from 'node:path'

import { isPlainId } from '../../shared/inbox.js'
import { DATA, FILES, log, print, readJson, writeAtomic, isAlive } from './runtime.mjs'

const refused = new Set()

/**
 * The entry at `target` when it is a plain file or folder inside the data
 * folder; null (logged once per path) for a symlink or junction, which
 * removal would follow out of the data folder, or anything outside it.
 * @param {string} target
 * @returns {fs.Stats | null}
 */
function plainEntry(target) {
  const stat = entryAt(target)
  if (!stat) return null
  const inside = path.relative(DATA, target)
  if (!stat.isSymbolicLink() && inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside)) return stat
  if (!refused.has(target)) {
    refused.add(target)
    log(`left ${path.basename(target)} in place: ${stat.isSymbolicLink() ? 'a link or junction' : 'outside the data folder'}, not removed`)
  }
  return null
}

/**
 * Removes a plain file, or a folder and its plain contents, inside the data
 * folder; links inside are left with their folder. True when all of it went.
 * @param {string} target
 * @returns {boolean}
 */
function removePlain(target) {
  if (!entryAt(target)) return true
  const stat = plainEntry(target)
  if (!stat) return false
  if (!stat.isDirectory()) {
    fs.rmSync(target, { force: true })
    return true
  }
  let isEmptied = true
  for (const name of fs.readdirSync(target)) if (!removePlain(path.join(target, name))) isEmptied = false
  if (isEmptied) fs.rmdirSync(target)
  return isEmptied
}

/** @param {string} target */
function entryAt(target) {
  try {
    return fs.lstatSync(target, { throwIfNoEntry: false }) ?? null
  } catch {
    return null
  }
}

/** @param {string} dir */
function isPlainDir(dir) {
  return plainEntry(dir)?.isDirectory() === true
}

function removeOld(dir, maxAgeMs) {
  let removed = 0
  if (!isPlainDir(dir)) return removed
  const now = Date.now()
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name)
    try {
      const stat = plainEntry(file)
      if (stat?.isFile() && now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(file)
        removed += 1
      }
    } catch {}
  }
  return removed
}

const REQUEST_KEEP_MS = 2 * 60_000
const ACK_KEEP_MS = 10 * 60_000
const SEEN_KEEP_MS = 24 * 60 * 60_000

export function pruneInbox(now = Date.now(), tracked = new Set()) {
  let removed = 0
  let folders = []
  if (!isPlainDir(FILES.inbox)) return removed
  try {
    folders = fs.readdirSync(FILES.inbox, { withFileTypes: true })
  } catch {
    return removed
  }
  for (const folder of folders) {
    if (!isPlainId(folder.name)) continue
    const dir = path.join(FILES.inbox, folder.name)
    if (!isPlainDir(dir)) continue
    try {
      for (const name of fs.readdirSync(dir)) {
        if (tracked.has(name.split('.')[0])) continue
        const file = path.join(dir, name)
        const keep = name === 'seen.json' ? SEEN_KEEP_MS : name.endsWith('.ack.json') ? ACK_KEEP_MS : REQUEST_KEEP_MS
        try {
          const stat = plainEntry(file)
          if (stat?.isFile() && now - stat.mtimeMs > keep) {
            fs.rmSync(file, { force: true })
            removed += 1
          }
        } catch {}
      }
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
    } catch {}
  }
  return removed
}

export const PRUNE_EVERY_MS = 6 * 60 * 60_000
export const FIRST_PRUNE_MS = 60_000

export function pruneFiles() {
  const sessions = removeOld(FILES.sessions, 7 * 24 * 60 * 60_000)
  const actions = removeOld(FILES.actions, 60 * 60_000)
  const inbox = pruneInbox()
  const approvals = pruneApprovals()
  log(`pruned ${sessions} session records, ${actions} actions, ${inbox} inbox files, ${approvals} approval files`)
  return { sessions, actions, inbox }
}

export function prune() {
  const { sessions, actions, inbox } = pruneFiles()
  print({ ok: true, message: `Pruned ${sessions} old session records, ${actions} old actions and ${inbox} old reply files.` })
}

/**
 * Removes Orbit's session data and resets the prefs (`clearedAt` hides
 * records older than now). The server's own files (`companion.json`, the
 * log) go only when the server is stopped first (`--clear`).
 */
export function clearData(files, { keepFolders = false } = {}) {
  const removed = []
  for (const target of [FILES.sessions, FILES.actions, FILES.inbox, FILES.approvals]) {
    if (!entryAt(target)) continue
    if (keepFolders) {
      if (!isPlainDir(target)) continue
      let isEmptied = true
      for (const name of fs.readdirSync(target)) if (!removePlain(path.join(target, name))) isEmptied = false
      if (isEmptied) removed.push(path.basename(target))
    } else if (removePlain(target)) removed.push(path.basename(target))
  }
  for (const file of files) {
    if (entryAt(file) && removePlain(file)) removed.push(path.basename(file))
  }
  const now = Date.now()
  writeAtomic(FILES.prefs, JSON.stringify({ schema: 1, updatedAt: now, clearedAt: now }, null, 1))
  removed.push('prefs.json (reset)')
  return removed
}

const APPROVAL_KEEP_MS = 10 * 60_000
const APPROVAL_FILE = /^([0-9a-f-]{36})(\.answer|\.done)?\.json$/

function approvalPaths(id) {
  return { request: path.join(FILES.approvals, `${id}.json`), answer: path.join(FILES.approvals, `${id}.answer.json`), done: path.join(FILES.approvals, `${id}.done.json`) }
}

function approvalNames() {
  if (!isPlainDir(FILES.approvals)) return []
  try {
    return fs.readdirSync(FILES.approvals)
  } catch {
    return []
  }
}

export function pruneApprovals(now = Date.now()) {
  let removed = 0
  for (const name of approvalNames()) {
    const file = path.join(FILES.approvals, name)
    const match = APPROVAL_FILE.exec(name)
    if (!(match || name.endsWith('.tmp'))) continue
    try {
      const stat = plainEntry(file)
      if (!stat?.isFile()) continue
      const isStaleRequest = match && !match[2] && !isAlive(readJson(file)?.hookPid ?? -1)
      if (isStaleRequest || now - stat.mtimeMs > APPROVAL_KEEP_MS) {
        fs.rmSync(file, { force: true })
        removed += 1
      }
    } catch {}
  }
  return removed
}
