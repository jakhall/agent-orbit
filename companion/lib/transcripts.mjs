import fs from 'node:fs'
import path from 'node:path'

import { editedPathsOf } from '../../shared/changes.js'
import { fileIdOf, offsetParam, readConversation, transcriptName } from '../../shared/conversation.js'
import { opts, isFile, readSnapshotForApi } from './runtime.mjs'

const transcriptPaths = new Map()
const transcriptMisses = new Map()
const MISS_TTL_MS = 5_000

export async function findTranscript(name, isRetry = false) {
  const known = transcriptPaths.get(name)
  if (known && (await isFile(known))) return known
  if (!isRetry && Date.now() - (transcriptMisses.get(name) ?? 0) < MISS_TTL_MS) return null
  const found = await scanTranscript(name)
  if (found) transcriptMisses.delete(name)
  else {
    transcriptMisses.set(name, Date.now())
    if (transcriptMisses.size > 200) transcriptMisses.delete(transcriptMisses.keys().next().value)
  }
  return found
}

async function scanTranscript(name) {
  let folders
  try {
    folders = await fs.promises.readdir(opts.projects)
  } catch {
    return null
  }
  for (const folder of folders) {
    const file = path.join(opts.projects, folder, name)
    if (await isFile(file)) {
      transcriptPaths.set(name, file)
      if (transcriptPaths.size > 200) transcriptPaths.delete(transcriptPaths.keys().next().value)
      return file
    }
  }
  return null
}

async function readRange(handle, begin, end) {
  const buffer = Buffer.alloc(Math.max(0, end - begin))
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, begin)
  return buffer.subarray(0, bytesRead)
}

export const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/

export async function conversation(key, cursor, isRetry, agentId = null) {
  const read = await readSnapshotForApi()
  if (read.error) return read.error
  const snapshot = read.snapshot
  const name = transcriptName(snapshot, key)
  if (!name) return { status: 404, body: { error: 'This session is no longer in Orbit.' } }
  const main = await findTranscript(name, isRetry)
  if (!main) return { status: 404, body: { error: 'No transcript found for this session.' } }
  let file = main
  if (agentId !== null) {
    const agents = Array.isArray(snapshot.agents) ? snapshot.agents : []
    if (!agents.some(a => a && a.key === `${key}/${agentId}`)) return { status: 404, body: { error: 'This sub-agent is no longer in Orbit.' } }
    file = path.join(path.dirname(main), name.replace(/.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`)
    if (!(await isFile(file))) return { status: 404, body: { error: 'No transcript found for this sub-agent yet.' } }
  }
  const handle = await fs.promises.open(file, 'r')
  try {
    const stat = await handle.stat()
    const fid = fileIdOf(stat)
    if (cursor && (cursor.fid !== fid || cursor.offset > stat.size)) return { status: 409, body: { error: 'The transcript changed; reload it.', reset: true } }
    const page = await readConversation((begin, end) => readRange(handle, begin, end), cursor ? { mode: cursor.mode, offset: cursor.offset, size: stat.size } : { mode: 'tail', size: stat.size }, undefined, { isSidechain: agentId !== null })
    return { status: 200, body: { ...page, fid } }
  } finally {
    await handle.close()
  }
}

export function conversationCursor(params) {
  const before = params.get('before')
  const from = params.get('from')
  if (before === null && from === null) return { ok: true, cursor: null }
  const fid = params.get('fid') ?? ''
  const offset = offsetParam(before ?? from)
  if ((before !== null && from !== null) || offset === null || fid === '' || fid.length > 100) return { ok: false }
  return { ok: true, cursor: { mode: before !== null ? 'before' : 'from', offset, fid } }
}

const editCache = new Map()
const EDIT_CACHE_FILES = 400
const EDIT_READ_BYTES = 64 * 1024 * 1024
const EDIT_READ_MS = 1_500
const EDIT_CHUNK = 1024 * 1024
const NEEDLE = Buffer.from('"tool_use"')

export async function transcriptEdits(file, deadline) {
  let stat
  try {
    stat = await fs.promises.stat(file)
  } catch {
    editCache.delete(file)
    return null
  }
  let entry = editCache.get(file)
  if (!entry || stat.size < entry.offset) entry = { offset: Math.max(0, stat.size - EDIT_READ_BYTES), paths: new Set(), isCut: stat.size > EDIT_READ_BYTES, isSynced: false }
  editCache.delete(file)
  editCache.set(file, entry)
  while (editCache.size > EDIT_CACHE_FILES) editCache.delete(editCache.keys().next().value)
  const result = () => ({ paths: entry.paths, isBehind: entry.offset < stat.size, isCut: entry.isCut })
  if (entry.offset >= stat.size) return result()
  let handle
  try {
    handle = await fs.promises.open(file, 'r')
  } catch {
    return result()
  }
  try {
    let position = entry.offset
    let carry = Buffer.alloc(0)
    let isSynced = entry.isSynced || entry.offset === 0
    while (position < stat.size && Date.now() < deadline) {
      const length = Math.min(EDIT_CHUNK, stat.size - position)
      const chunk = Buffer.alloc(length)
      const { bytesRead } = await handle.read(chunk, 0, length, position)
      if (bytesRead <= 0) break
      position += bytesRead
      const buffer = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      let start = 0
      for (let nl = buffer.indexOf(10); nl !== -1; nl = buffer.indexOf(10, start)) {
        const line = buffer.subarray(start, nl)
        start = nl + 1
        if (!isSynced) {
          isSynced = true
          continue
        }
        if (line.indexOf(NEEDLE) !== -1) for (const p of editedPathsOf(line.toString('utf8'))) entry.paths.add(p)
      }
      carry = buffer.subarray(start)
      entry.offset = position - carry.length
    }
    entry.isSynced = isSynced
    return result()
  } catch {
    return result()
  } finally {
    await handle.close().catch(() => {})
  }
}

export async function sessionEdits(cliName) {
  const deadline = Date.now() + EDIT_READ_MS
  const main = await findTranscript(cliName)
  if (!main) return { paths: [], isPartial: false, isCut: false }
  const files = [main]
  const sidechains = path.join(path.dirname(main), cliName.replace(/\.jsonl$/, ''), 'subagents')
  try {
    for (const name of await fs.promises.readdir(sidechains)) if (/^[\w.-]+\.jsonl$/.test(name)) files.push(path.join(sidechains, name))
  } catch {}
  const paths = new Set()
  let isPartial = false
  let isCut = false
  for (const file of files) {
    const result = Date.now() < deadline ? await transcriptEdits(file, deadline) : null
    if (!result) {
      isPartial ||= Date.now() >= deadline
      continue
    }
    for (const p of result.paths) paths.add(p)
    isPartial ||= result.isBehind
    isCut ||= result.isCut
  }
  return { paths: [...paths], isPartial, isCut }
}
