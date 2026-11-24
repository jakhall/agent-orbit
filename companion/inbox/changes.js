import { plural } from '/shared/format.js'
import { api, el } from './ctx.js'
import { icon } from './icons.js'

const CHANGES_SESSIONS = 12
const CHANGES_FRESH_MS = 10_000
const TRACKED_SHOWN = 20
const OPEN_KEY = 'orbit.changesOpen'
const STATUS_WORD = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', T: 'type changed' }
const STATE_HINT = {
  unsafe: 'Git refuses folders owned by another user (safe.directory).',
  network: 'Its Git data is on a network share, which Orbit does not read.',
  'no-git': 'Git for Windows was not found.',
  timeout: 'Git took longer than 4 seconds; it will be asked again on the next refresh.',
  error: 'Git could not read this folder as a working tree.',
}
const STATE_SUMMARY = {
  'not-repo': 'Not a git checkout',
  unsafe: 'Git refused this folder',
  network: 'Repository on a network share',
  timeout: 'Git did not answer in time',
  'no-git': 'Git not found',
  missing: 'Folder not found',
  error: 'Git could not read this folder',
}

const cache = new Map()
const showAll = new Set()
const shown = { key: null, block: null }
let loadingKey = null

const thousands = n => n.toLocaleString('en-US')

function isOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) === 'true'
  } catch {
    return false
  }
}

function summaryOf(view) {
  if (!view) return ''
  if (view.state !== 'ok') return STATE_SUMMARY[view.state] ?? ''
  const { files, added, removed } = view.totals
  const untracked = view.untracked.count
  if (files === 0 && untracked === 0) return 'No changes'
  const parts = []
  if (files > 0) parts.push(plural(files, 'file').replace(/^\d+/, thousands(files)), `+${thousands(added)} −${thousands(removed)}`)
  if (untracked > 0) parts.push(`${thousands(untracked)} new`)
  return parts.join(' · ')
}

function upstreamText(upstream) {
  if (!upstream) return 'no upstream'
  const parts = [upstream.ahead ? `${upstream.ahead} ahead` : '', upstream.behind ? `${upstream.behind} behind` : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'up to date'
}

async function load(key) {
  if (loadingKey === key) return
  loadingKey = key
  const current = cache.get(key)
  cache.delete(key)
  cache.set(key, { ...(current ?? { view: null, error: null }), status: 'loading', fetchedAt: current?.fetchedAt ?? 0 })
  while (cache.size > CHANGES_SESSIONS) cache.delete(cache.keys().next().value)
  let next
  try {
    const view = await api('GET', `/api/changes?key=${encodeURIComponent(key)}`)
    next = { status: 'ok', view, error: null, fetchedAt: Date.now() }
  } catch (error) {
    next = { status: 'error', view: error.status === 404 ? null : (current?.view ?? null), error: error.status === 404 ? error.message : 'Couldn’t read the changes.', fetchedAt: Date.now() }
  } finally {
    if (loadingKey === key) loadingKey = null
  }
  if (!cache.has(key)) return
  cache.set(key, next)
  paint(key)
}

/** Reads the shown session's changes while the section is open and the window is visible, at most every 10 s. */
export function refreshChanges() {
  const key = shown.key
  if (!key || !shown.block?.open || document.hidden) return
  const current = cache.get(key)
  if (current?.status === 'loading' || (current && Date.now() - current.fetchedAt < CHANGES_FRESH_MS)) return
  void load(key)
}

function paint(key) {
  if (shown.key !== key || !shown.block) return
  const body = shown.block.querySelector('.changes')
  const hadFocus = body?.contains(document.activeElement)
  body?.replaceWith(changesBody(key))
  const count = shown.block.querySelector('.h-count')
  if (count) count.textContent = summaryOf(cache.get(key)?.view)
  if (hadFocus) shown.block.querySelector('.changes')?.focus({ preventScroll: true })
}

/**
 * 1.15's Changes section for a session with a folder: a disclosure with the
 * accent diff icon and a one-line summary, whose body (git status of the
 * checkout and the files this session edited) loads while it is open.
 */
export function changesSection(s) {
  const block = el(
    'details',
    { class: 'cx-section cx-changes', open: isOpen() || null },
    el('summary', {}, icon('chevron', 'chev'), icon('diff', 'accent'), el('span', { class: 'h-title' }, 'Changes'), el('span', { class: 'h-count' }, summaryOf(cache.get(s.key)?.view))),
    changesBody(s.key),
  )
  block.addEventListener('toggle', () => {
    try {
      localStorage.setItem(OPEN_KEY, String(block.open))
    } catch {}
    refreshChanges()
  })
  shown.key = s.key
  shown.block = block
  return block
}

function pathLabel(path, separator = '/') {
  const trimmed = path.replace(/[\\/]$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const dir = at < 0 ? '' : path.slice(0, at + 1)
  const name = at < 0 ? path : path.slice(at + 1)
  return el('span', { class: 'chg-path' }, dir ? el('span', { class: 'chg-dir' }, dir.replace(/[\\/]/g, separator)) : null, el('span', { class: 'chg-name' }, name))
}

function fileRow(f) {
  const word = STATUS_WORD[f.status] ?? 'changed'
  const counts = f.isBinary ? 'bin' : f.added === null ? '' : `+${thousands(f.added)} −${thousands(f.removed)}`
  return el(
    'div',
    { class: 'chg-row', title: `${f.oldPath ? `${f.oldPath} → ` : ''}${f.path} · ${word}` },
    pathLabel(f.path),
    el('span', { class: 'chg-num' }, counts),
    el('span', { class: 'chg-st' }, el('span', { 'aria-hidden': 'true' }, f.status), el('span', { class: 'sr-only' }, word)),
  )
}

const subhead = text => el('div', { class: 'chg-sub' }, text)
const more = (count, text = `+${thousands(count)} more`) => (count > 0 ? el('div', { class: 'chg-more' }, text) : null)

function trackedRows(key, view) {
  const isAll = showAll.has(key)
  const edited = view.files.filter(f => f.isEdited)
  const other = view.files.filter(f => !f.isEdited)
  let budget = isAll ? Infinity : TRACKED_SHOWN
  const take = list => {
    const rows = list.slice(0, Math.max(0, budget))
    budget -= rows.length
    return rows
  }
  const editedShown = take(edited)
  const otherShown = take(other)
  const hiddenHere = view.files.length - editedShown.length - otherShown.length
  const parts = []
  if (edited.length) parts.push(subhead(`Edited by this session · ${thousands(edited.length)}`), ...editedShown.map(fileRow))
  if (edited.length && other.length) parts.push(subhead(`Other changes · ${thousands(other.length + view.moreFiles)}`))
  parts.push(...otherShown.map(fileRow))
  if (hiddenHere > 0) parts.push(el('button', { class: 'ghost small chg-all', onclick: () => (showAll.add(key), paint(key)) }, `Show all ${thousands(view.files.length)}`))
  if (isAll || hiddenHere === 0) parts.push(more(view.moreFiles))
  return parts
}

function nested(title, count, rows) {
  return el('details', { class: 'chg-nested' }, el('summary', {}, icon('chevron', 'chev'), el('span', { class: 'h-title' }, title), el('span', { class: 'h-count' }, thousands(count))), ...rows.filter(Boolean))
}

function untrackedSection(view) {
  if (!view.untracked.count) return null
  const rows = view.untracked.names.map(u => el('div', { class: 'chg-row', title: `${u.path} · untracked${u.isEdited ? ' · edited by this session' : ''}` }, pathLabel(u.path)))
  return nested('Untracked', view.untracked.count, [...rows, more(view.untracked.count - rows.length)])
}

function outsideSection(view, title) {
  const outside = view.outside
  if (!outside?.count) return null
  const body = []
  if (outside.scratch) body.push(el('div', { class: 'chg-more', title: 'Temp and scratchpad folders, session memory, plans and tasks under .claude' }, plural(outside.scratch, 'agent working file')))
  for (const group of outside.groups) {
    body.push(el('div', { class: 'chg-sub', title: group.root }, `${group.label} · ${thousands(group.count)}`))
    for (const rel of group.paths) body.push(el('div', { class: 'chg-row', title: `${group.root}\\${rel}` }, pathLabel(rel.split(/[\\/]/).slice(-2).join('\\'), '\\')))
    body.push(more(group.count - group.paths.length))
  }
  body.push(more(outside.moreGroups, `+${plural(outside.moreGroups, 'more folder')}`))
  return nested(title, outside.count, body)
}

function changesBody(key) {
  const entry = cache.get(key)
  const view = entry?.view ?? null
  const body = el('div', { class: 'changes', tabindex: '0', role: 'region', 'aria-label': 'Changes' })
  if (!view) {
    body.append(el('p', { class: 'note' }, entry?.status === 'error' ? entry.error : 'Loading…'))
    if (entry?.status === 'error') body.append(retry(key))
    return body
  }
  if (view.state !== 'ok') {
    const hint = STATE_HINT[view.state]
    if (hint) body.append(el('p', { class: 'note' }, hint))
    const edits = outsideSection(view, 'Edited by this session')
    if (edits) body.append(edits)
    else if (!hint) body.append(el('p', { class: 'note' }, 'No edits recorded by this session.'))
    return body
  }
  body.append(el('div', { class: 'chg-meta' }, `${view.branch ?? 'no branch'} · ${view.hasHead ? upstreamText(view.upstream) : 'no commits yet'}`))
  if (view.files.length === 0 && view.untracked.count === 0) body.append(el('p', { class: 'note' }, 'Nothing changed since the last commit.'))
  body.append(...trackedRows(key, view).filter(Boolean))
  const untracked = untrackedSection(view)
  const outside = outsideSection(view, 'Outside this checkout')
  if (untracked) body.append(untracked)
  if (outside) body.append(outside)
  if (view.edits?.isCut) body.append(el('p', { class: 'note' }, 'Session edits: only the last 64 MB of a long transcript are read.'))
  else if (view.edits?.isPartial) body.append(el('p', { class: 'note' }, 'Session edits: still reading the transcript.'))
  if (entry.status === 'error') body.append(el('div', { class: 'convo-error' }, el('span', { class: 'note' }, entry.error), retry(key)))
  return body
}

function retry(key) {
  return el('button', { class: 'icon-btn ghost small', title: 'Retry', 'aria-label': 'Retry', onclick: () => void load(key) }, icon('reset'))
}
