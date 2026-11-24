import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { MOD_VERSION } from '../../shared/constants.js'
import { launchDecision } from './daemon.mjs'
import { clearData } from './prune.mjs'
import { SELF, opts, DATA, FILES, log, print, readJson, pause, isAlive, childEnv } from './runtime.mjs'

export function request(port, token, method, route, body) {
  return new Promise(resolve => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: route, headers: { 'x-orbit-token': token, 'content-type': 'application/json' }, timeout: 3000 },
      res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      },
    )
    req.on('error', () => resolve({ status: 0, text: '' }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, text: '' })
    })
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

const SERVER_LOCK_STALE_MS = 30_000
const HAND_OVER_WAIT_MS = 5_000

/**
 * One server per data folder: the first `--serve` creates `server.lock`
 * (exclusive create). Returns null once this process holds the lock, or the
 * holder's record while another live process does. A lock whose process is
 * gone is taken over.
 */
export function claimServerLock() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(FILES.lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' })
      return null
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const held = readJson(FILES.lock)
    const age = Date.now() - (fs.statSync(FILES.lock, { throwIfNoEntry: false })?.mtimeMs ?? 0)
    if (Number.isInteger(held?.pid) && held.pid !== process.pid && isAlive(held.pid)) return { ...held, age }
    if (!held && age < 2_000) {
      Atomics.wait(pause, 0, 0, 100)
      continue
    }
    fs.rmSync(FILES.lock, { force: true })
  }
  return null
}

export function releaseServerLock() {
  try {
    if (readJson(FILES.lock)?.pid === process.pid) fs.rmSync(FILES.lock, { force: true })
  } catch {}
}

/**
 * Another live server owns this data folder: ask it to open a window when
 * this one was started to open one, report its port, and exit. A lock held
 * by a live process that never answers (a reused pid) is taken over once it
 * is older than SERVER_LOCK_STALE_MS.
 */
export async function handOver(owner) {
  const until = Date.now() + HAND_OVER_WAIT_MS
  while (Date.now() < until) {
    const info = await runningServer()
    if (info && info.pid === owner.pid) {
      const opened = opts.open && !opts.dryRun ? await request(info.port, info.token, 'POST', '/api/window', {}) : null
      log(`another server (pid ${info.pid}) owns this data folder on port ${info.port}; handing over`)
      const refusal = opened && opened.status !== 200 ? parseMessage(opened.text) : null
      print({ ok: refusal === null, port: info.port, message: refusal ?? `An Orbit server is already running on port ${info.port}.` })
      return true
    }
    await new Promise(r => setTimeout(r, 200))
  }
  if (owner.age + HAND_OVER_WAIT_MS > SERVER_LOCK_STALE_MS) {
    log(`server.lock held by pid ${owner.pid}, which never answered; taking it over`)
    fs.rmSync(FILES.lock, { force: true })
    return claimServerLock() !== null
  }
  print({ ok: false, message: `Another Orbit server (pid ${owner.pid}) is starting on this data folder.` })
  process.exitCode = 1
  return true
}

async function runningServer() {
  const info = readJson(FILES.companion)
  if (!info || !info.port || !info.token || !info.pid || !isAlive(info.pid)) return null
  const ping = await request(info.port, info.token, 'GET', '/api/ping')
  return ping.status === 200 ? info : null
}

function edgePath() {
  const candidates = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean)
  return candidates.find(p => fs.existsSync(p)) ?? null
}

export const EDGE_REQUIRED = 'Microsoft Edge is required for the pop-out window.'

/**
 * Opens the pop-out as an Edge app window with Orbit's own profile. Without
 * Edge it opens nothing: the launch link would otherwise reach a browser
 * profile Orbit does not control.
 * @param {number} port
 * @param {string} launchCode
 * @returns {{ isOpened: boolean, message: string }}
 */
export function openWindow(port, launchCode) {
  const edge = edgePath()
  if (!edge) {
    log('Edge not found; no pop-out window opened')
    return { isOpened: false, message: EDGE_REQUIRED }
  }
  const url = `http://127.0.0.1:${port}/inbox?launch=${launchCode}`
  const child = spawn(
    edge,
    [`--app=${url}`, `--user-data-dir=${FILES.profile}`, '--window-size=1220,760', '--no-first-run', '--no-default-browser-check'],
    { detached: true, stdio: 'ignore', windowsHide: false, cwd: DATA, env: childEnv() },
  )
  child.on('error', error => log(`edge failed: ${error.message}`))
  child.unref()
  log(`opened Edge app window on port ${port}`)
  return { isOpened: true, message: 'Pop-out window opened.' }
}

/**
 * Starts the server, or reuses or replaces the running one. A running server
 * is replaced only when it is older than this file, never when it is newer
 * (mixed versions: every session runs the on-disk launcher). `--no-window`
 * starts or keeps a daemon without opening a window.
 */
export async function launch() {
  fs.mkdirSync(DATA, { recursive: true })
  const running = await runningServer()
  const decision = launchDecision(running, MOD_VERSION, !opts.noWindow)
  if (running && decision.action === 'replace') {
    log(`replacing a running ${running.version ?? 'older'} server with ${MOD_VERSION}`)
    await request(running.port, running.token, 'POST', '/api/shutdown', {})
    const until = Date.now() + 3_000
    while (Date.now() < until && isAlive(running.pid)) await new Promise(r => setTimeout(r, 100))
  }
  if (running && decision.action === 'reuse') {
    if (!decision.openWindow) {
      print({ ok: true, message: 'The Orbit server is already running.', version: running.version })
      return
    }
    const opened = await request(running.port, running.token, 'POST', '/api/window', {})
    const said = parseMessage(opened.text)
    print({ ok: opened.status === 200, message: opened.status === 200 ? 'Pop-out window opened.' : said ?? 'The running dashboard server did not answer.' })
    return
  }
  const before = readJson(FILES.companion)
  const serveArgs = [SELF, '--serve', decision.openWindow ? '--open' : '--daemon', '--data', DATA]
  if (opts.dryRun) serveArgs.push('--dry-run')
  const child = spawn(process.execPath, serveArgs, {
    cwd: DATA,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: childEnv(),
  })
  child.unref()
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250))
    const info = readJson(FILES.companion)
    if (info && info.port && isAlive(info.pid) && (!before || before.startedAt !== info.startedAt)) {
      print({ ok: info.message !== EDGE_REQUIRED, message: info.message || (decision.openWindow ? 'Pop-out window opened.' : 'The Orbit server started.'), version: info.version })
      return
    }
  }
  print({ ok: false, message: `The dashboard server did not start; see ${FILES.log}` })
  process.exitCode = 1
}

/** @param {string} text */
function parseMessage(text) {
  try {
    const message = JSON.parse(text)?.message
    return typeof message === 'string' ? message : null
  } catch {
    return null
  }
}

export async function clear() {
  const server = await runningServer()
  if (server) await request(server.port, server.token, 'POST', '/api/shutdown', {})
  const removed = clearData([FILES.snapshot, FILES.snapshotV2, path.join(DATA, 'leader.json'), FILES.companion, FILES.log])
  let profileNote = ''
  if (fs.lstatSync(FILES.profile, { throwIfNoEntry: false })?.isSymbolicLink()) log('left edge-profile in place: a link or junction, not removed')
  else if (fs.existsSync(FILES.profile)) {
    try {
      fs.rmSync(FILES.profile, { recursive: true, force: true })
      removed.push('edge-profile')
    } catch {
      profileNote = ' The pop-out window profile is in use; close the window and clear again to remove it.'
    }
  }
  print({ ok: true, message: `Cleared ${removed.length ? removed.join(', ') : 'nothing (already empty)'}.${profileNote}` })
}
