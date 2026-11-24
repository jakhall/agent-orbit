import fs from 'node:fs'
import path from 'node:path'

import { promptSuggestionOf } from '../../shared/aggregate/desktop.js'
import { isDesktopSessionId } from '../../shared/links.js'
import { desktopRoot, isFile, readSnapshotForApi } from './runtime.mjs'

const RECORD_MAX_BYTES = 8 * 1024 * 1024
const recordPaths = new Map()

async function findRecord(root, localId) {
  const name = `${localId}.json`
  const known = recordPaths.get(localId)
  if (known && (await isFile(known))) return known
  for (const account of await fs.promises.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!account.isDirectory()) continue
    for (const org of await fs.promises.readdir(path.join(root, account.name), { withFileTypes: true }).catch(() => [])) {
      if (!org.isDirectory()) continue
      const file = path.join(root, account.name, org.name, name)
      if (!(await isFile(file))) continue
      recordPaths.set(localId, file)
      if (recordPaths.size > 200) recordPaths.delete(recordPaths.keys().next().value)
      return file
    }
  }
  return null
}

/**
 * The desktop's suggested next prompt for a session in the current snapshot,
 * read from its record on request and returned, never kept, logged or
 * written (docs/RULES.md conversation privacy).
 */
export async function suggestion(key) {
  const read = await readSnapshotForApi()
  if (read.error) return read.error
  const sessions = Array.isArray(read.snapshot.sessions) ? read.snapshot.sessions : []
  const session = sessions.find(s => s && s.key === key)
  if (!session) return { status: 404, body: { error: 'This session is no longer in Orbit.' } }
  const root = desktopRoot()
  const localId = session.localId
  if (!root || typeof localId !== 'string' || !isDesktopSessionId(localId)) return { status: 200, body: { text: null } }
  const file = await findRecord(root, localId)
  if (!file) return { status: 200, body: { text: null } }
  try {
    const stat = await fs.promises.stat(file)
    if (stat.size > RECORD_MAX_BYTES) return { status: 200, body: { text: null } }
    return { status: 200, body: { text: promptSuggestionOf(JSON.parse(await fs.promises.readFile(file, 'utf8'))) } }
  } catch {
    return { status: 200, body: { text: null } }
  }
}
