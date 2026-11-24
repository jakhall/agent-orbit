import { execFile } from 'node:child_process'
import path from 'node:path'

import { prProblem } from '../../shared/filters.js'
import { ghUnavailable, isPrDue, isPrUrl, prSummary, prViewArgs } from '../../shared/prs.js'
import { sessionFoldersOf, findToolExe } from './git-changes.mjs'
import { opts, DATA, log, readJson, toolEnv, readSnapshotForApi } from './runtime.mjs'

const PR_SESSION_DAYS = 7
const PR_MAX = 30
const PR_PARALLEL = 2
const PR_TIMEOUT_MS = 10_000
const PR_BACKOFF_MS = 10 * 60_000
export const PR_TICK_MS = 15_000
export const PR_WANT_MS = 5 * 60_000
export const prs = { entries: new Map(), version: 0, backoffUntil: 0, checks: { state: 'idle', reason: null }, calls: [] }

function setPrChecks(state, reason) {
  if (prs.checks.state === state && prs.checks.reason === reason) return
  prs.checks = { state, reason }
  prs.version += 1
  log(`PR checks: ${state}${reason ? ` (${reason})` : ''}`)
}

export function prAnswer() {
  const statuses = {}
  const unreadable = []
  for (const [url, entry] of prs.entries) {
    if (entry.status) statuses[url] = entry.status
    else if (entry.failed) unreadable.push(url)
  }
  return { statuses, unreadable, checks: prs.checks, version: prs.version }
}

function linkedPrUrls(snapshot, now) {
  const sessions = (Array.isArray(snapshot?.sessions) ? snapshot.sessions : [])
    .filter(s => s && Array.isArray(s.prs) && typeof s.lastActivityAt === 'number' && now - s.lastActivityAt <= PR_SESSION_DAYS * 86_400_000)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const urls = []
  for (const s of sessions) for (const pr of s.prs) if (isPrUrl(pr?.url) && !urls.includes(pr.url)) urls.push(pr.url)
  return urls.slice(0, PR_MAX)
}

function readPrFixtures() {
  const fixtures = readJson(path.join(DATA, 'pr-fixtures.json'))
  return fixtures && typeof fixtures === 'object' && !Array.isArray(fixtures) ? fixtures : {}
}

async function viewPr(url, fixtures, sessionFolders) {
  const args = prViewArgs(url)
  if (opts.dryRun) {
    prs.calls.push(['gh', ...args])
    if (prs.calls.length > 50) prs.calls.shift()
    const fixture = Object.hasOwn(fixtures, url) ? fixtures[url] : undefined
    if (fixture === undefined) return { ok: false, stderr: 'no fixture', code: 1 }
    if (typeof fixture?.error === 'string') return { ok: false, stderr: fixture.error, code: fixture.code ?? 1 }
    return { ok: true, json: fixture }
  }
  const exe = await findToolExe('gh', sessionFolders)
  if (!exe) return { ok: false, stderr: '', code: 'ENOENT' }
  return new Promise(resolve => {
    execFile(
      exe,
      args,
      { cwd: DATA, windowsHide: true, timeout: PR_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, env: toolEnv({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }) },
      (error, stdout, stderr) => {
        if (error) return resolve({ ok: false, stderr: String(stderr ?? ''), code: error.code ?? 1 })
        try {
          resolve({ ok: true, json: JSON.parse(String(stdout)) })
        } catch {
          resolve({ ok: false, stderr: 'unreadable answer', code: 1 })
        }
      },
    )
  })
}

function storePrStatus(url, status, failed) {
  const before = prs.entries.get(url)
  const now = Date.now()
  let since = null
  if (status && prProblem(status)) since = before?.status && prProblem(before.status) === prProblem(status) ? (before.status.since ?? now) : now
  const next = { status: status ? { ...status, since } : (before?.status ?? null), checkedAt: now, failed }
  const shape = entry => (entry ? JSON.stringify({ ...entry.status, checkedAt: 0, failed: !entry.status && entry.failed }) : '')
  if (shape(before) !== shape(next)) prs.version += 1
  prs.entries.set(url, next)
}

export async function refreshPrs() {
  const now = Date.now()
  if (now < prs.backoffUntil) return
  const read = await readSnapshotForApi()
  if (read.error || !read.snapshot) return
  const urls = linkedPrUrls(read.snapshot, now)
  for (const url of [...prs.entries.keys()]) {
    if (urls.includes(url)) continue
    prs.entries.delete(url)
    prs.version += 1
  }
  const due = urls.filter(url => isPrDue(prs.entries.get(url), now))
  const fixtures = opts.dryRun ? readPrFixtures() : {}
  const sessionFolders = sessionFoldersOf(read.snapshot)
  const worker = async () => {
    while (due.length > 0 && Date.now() >= prs.backoffUntil) {
      const url = due.shift()
      const answer = await viewPr(url, fixtures, sessionFolders)
      const summary = answer.ok ? prSummary(answer.json, Date.now()) : null
      if (summary) {
        storePrStatus(url, summary, false)
        setPrChecks('ok', null)
        continue
      }
      const reason = answer.ok ? null : ghUnavailable(answer.stderr, answer.code)
      if (reason) {
        prs.backoffUntil = Date.now() + PR_BACKOFF_MS
        setPrChecks('unavailable', reason)
        return
      }
      storePrStatus(url, null, true)
    }
  }
  await Promise.all(Array.from({ length: PR_PARALLEL }, worker))
}
