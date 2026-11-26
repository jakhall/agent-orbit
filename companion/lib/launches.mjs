import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { checkLaunch, FIRST_PROMPT_WAIT_MS, isAnthropicSigned, isRunnable, LAUNCH_AGAIN_MS, LAUNCH_NEEDS_REPLIES, launchArgv, launchEnv, launchFolder, launchModels, launchNeedsReplies, newestClaude } from '../../shared/launch.js'
import { normalizeFolder } from '../../shared/links.js'
import { checkLaunchPrompt, sanitizeSkillShelf } from '../../shared/skills.js'
import { REPLY_PROTOCOL } from './replies.mjs'
import { isRepliesArmed, replyQueue, replyResult } from './reply-api.mjs'
import { SYSTEM32, opts, DATA, FILES, log, readJson, isFolder, childEnv, readSnapshotForApi } from './runtime.mjs'

let claudeExe = null
function findClaudeExe() {
  if (claudeExe !== null) return Promise.resolve(claudeExe)
  return new Promise(resolve => {
    execFile(path.join(SYSTEM32, 'reg.exe'), ['query', 'HKCU\\Software\\Classes\\claude\\shell\\open\\command', '/ve'], { windowsHide: true, cwd: DATA, timeout: 10_000 }, (error, stdout, stderr) => {
      const found = error ? null : stdout.match(/"([^"]+\\Claude\.exe)"/i)?.[1] ?? null
      if (found) claudeExe = found
      else log(`claude:// handler lookup failed: ${error ? `${error.code ?? 'error'} ${String(stderr || error.message).trim().slice(0, 200)}` : 'no Claude.exe in the registered command'}`)
      resolve(found)
    })
  })
}

export const NO_HANDLER = 'no-handler'

export const dryRunLaunches = []

/**
 * Hands a `claude://` link to Claude.exe (the app's registered handler) and
 * resolves once the process has started, or rejects when it could not.
 */
export async function launchLink(url) {
  const exe = await findClaudeExe()
  if (!exe) throw Object.assign(new Error("Orbit's server couldn't find Claude desktop's claude:// link handler"), { code: NO_HANDLER })
  if (opts.dryRun) {
    dryRunLaunches.push([exe, url])
    if (dryRunLaunches.length > 20) dryRunLaunches.shift()
    return
  }
  await new Promise((resolve, reject) => {
    const child = spawn(exe, [url], { detached: true, stdio: 'ignore', cwd: DATA, env: childEnv() })
    child.once('spawn', () => {
      child.unref()
      resolve(undefined)
    })
    child.once('error', error => {
      claudeExe = null
      reject(error)
    })
  })
}

export const dryRunBrowser = []

/**
 * Opens an http(s) address (already passed through `browserUrl`) in the
 * default browser through the URL protocol handler, with no shell between,
 * and resolves once that process has started.
 * @param {string} url
 */
export function openInBrowser(url) {
  if (opts.dryRun) {
    dryRunBrowser.push(url)
    if (dryRunBrowser.length > 20) dryRunBrowser.shift()
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(SYSTEM32, 'rundll32.exe'), ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true, cwd: DATA, env: childEnv() })
    child.once('spawn', () => {
      child.unref()
      resolve(undefined)
    })
    child.once('error', reject)
  })
}

export const launches = { lastAt: 0, isBusy: false, spawns: [], prompts: new Map(), states: new Map() }
const driveTypes = new Map()
const signatures = new Map()

function realFolder(folder) {
  try {
    return fs.realpathSync.native(folder)
  } catch {
    return null
  }
}

function driveType(letter) {
  const drive = letter.toUpperCase()
  if (!/^[A-Z]$/.test(drive)) return Promise.resolve('Unknown')
  if (driveTypes.has(drive)) return driveTypes.get(drive)
  const found = new Promise(resolve => {
    execFile(
      path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `[System.IO.DriveInfo]::new('${drive}').DriveType.ToString()`],
      { cwd: SYSTEM32, windowsHide: true, timeout: 10_000 },
      (error, stdout) => resolve(error ? 'Unknown' : String(stdout).trim() || 'Unknown'),
    )
  })
  driveTypes.set(drive, found)
  return found
}

async function isRemoteDrive(folder) {
  if (/^[\\/]{2}/.test(folder)) return true
  const type = await driveType(folder.charAt(0))
  return type !== 'Fixed' && type !== 'Removable' && type !== 'Ram'
}

export async function checkFolder(text) {
  const folder = normalizeFolder(typeof text === 'string' ? text : '')
  if (!folder) return { status: 400, body: { error: 'Enter an absolute local folder, like C:\\repos\\app.' } }
  if (await isRemoteDrive(folder)) return { status: 400, body: { error: 'Orbit does not start sessions on network drives.' } }
  if (!(await isFolder(folder))) return { status: 404, body: { error: `No folder at ${folder}.` } }
  const realRaw = realFolder(folder)
  const real = realRaw ? normalizeFolder(realRaw) : null
  if (!real || /^[\\/]{2}/.test(realRaw) || (await isRemoteDrive(real))) return { status: 400, body: { error: 'Orbit does not start sessions on network drives.' } }
  const digest = createHash('sha256').update(JSON.stringify({ real })).digest('hex')
  return { status: 200, body: { folder, real, launchable: launchFolder(real) !== null, digest } }
}

function findWt() {
  const wt = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe')
  if (!wt) return null
  try {
    return isRunnable(fs.lstatSync(wt)) ? wt : null
  } catch {
    return null
  }
}

function findLaunchClaude() {
  const root = process.env.APPDATA && path.join(process.env.APPDATA, 'Claude', 'claude-code')
  if (!root) return null
  const found = []
  try {
    for (const version of fs.readdirSync(root)) {
      let hashes = []
      try {
        hashes = fs.readdirSync(path.join(root, version))
      } catch {
        continue
      }
      for (const hash of hashes) {
        const exe = path.join(root, version, hash, 'claude.exe')
        if (fs.existsSync(exe)) found.push({ version, path: exe })
      }
    }
  } catch {
    return null
  }
  return newestClaude(found)
}

function isSignedClaude(exe) {
  let mtime = 0
  try {
    mtime = fs.statSync(exe).mtimeMs
  } catch {
    return Promise.resolve(false)
  }
  const cached = signatures.get(exe)
  if (cached && cached.mtime === mtime) return cached.ok
  const ok = new Promise(resolve => {
    execFile(
      path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', "Get-AuthenticodeSignature -LiteralPath $env:ORBIT_SIGNED_FILE | Select-Object @{n='Status';e={[int]$_.Status}},@{n='Subject';e={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress"],
      { cwd: SYSTEM32, windowsHide: true, timeout: 20_000, env: { ...launchEnv(process.env).env, ORBIT_SIGNED_FILE: exe } },
      (error, stdout) => {
        if (error) return resolve(false)
        try {
          resolve(isAnthropicSigned(JSON.parse(String(stdout))))
        } catch {
          resolve(false)
        }
      },
    )
  })
  signatures.set(exe, { mtime, ok })
  return ok
}

function spawnTerminal(argv, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: 'ignore', windowsHide: false, env })
    child.once('spawn', () => {
      child.unref()
      resolve(undefined)
    })
    child.once('error', reject)
  })
}

export async function launchSession(body) {
  if (launches.isBusy || Date.now() - launches.lastAt < LAUNCH_AGAIN_MS) return { status: 429, body: { error: 'One launch every 3 seconds; try again.' } }
  launches.isBusy = true
  try {
    return await launchChecked(body)
  } finally {
    launches.isBusy = false
  }
}

/** Model ids sessions in the current snapshot used, most recently active first. */
export async function seenModels() {
  const read = await readSnapshotForApi()
  const sessions = Array.isArray(read.snapshot?.sessions) ? read.snapshot.sessions : []
  return [...sessions].sort((a, b) => (Number(b?.lastActivityAt) || 0) - (Number(a?.lastActivityAt) || 0)).map(s => s?.model)
}

async function launchChecked(body) {
  const checked = checkLaunch(body, launchModels(await seenModels()))
  if (!checked.ok) return { status: 400, body: { error: checked.error } }
  if (checked.prompt) {
    const prompt = checkLaunchPrompt(checked.prompt, sanitizeSkillShelf(readJson(FILES.prefs)?.skillShelf))
    if (!prompt.ok) return { status: 400, body: { error: prompt.error } }
  }
  if (launchNeedsReplies(checked) && !isRepliesArmed()) return { status: 409, body: { error: LAUNCH_NEEDS_REPLIES, reason: 'not-armed' } }
  const review = await checkFolder(checked.folder)
  if (review.status !== 200) return review
  const info = review.body
  if (info.digest !== checked.digest) return { status: 409, body: { error: 'Folder changed, check again.' } }
  if (!info.launchable) return { status: 400, body: { error: 'Orbit will not pass this path to a terminal.' } }
  const wt = findWt()
  const claude = findLaunchClaude()
  if (!opts.dryRun && !wt) return { status: 502, body: { error: 'Windows Terminal (wt.exe) was not found, so Orbit cannot open a session window.' } }
  if (!opts.dryRun && !claude) return { status: 502, body: { error: 'The Claude Code that ships with Claude desktop was not found.' } }
  const signed = claude ? await isSignedClaude(claude) : null
  if (claude && !signed && !opts.dryRun) return { status: 502, body: { error: 'The Claude Code that ships with Claude desktop is not signed by Anthropic; Orbit will not start it.' } }
  launches.lastAt = Date.now()
  const sessionId = randomUUID()
  const argv = launchArgv({ wt: wt ?? 'wt.exe', claude: claude ?? 'claude.exe', folder: info.real, sessionId, model: checked.model, effort: checked.effort, mode: checked.mode })
  const { env, removed } = launchEnv(process.env)
  if (opts.dryRun) {
    launches.spawns.push({ argv, cwd: info.real, envKept: Object.keys(env).sort(), envRemoved: removed, signed })
    if (launches.spawns.length > 20) launches.spawns.shift()
  } else {
    try {
      await spawnTerminal(argv, info.real, env)
    } catch (error) {
      log(`launch failed: ${error.code ?? error.name}`)
      return { status: 502, body: { error: 'Windows Terminal did not start.' } }
    }
  }
  launches.states.set(sessionId, { prompt: checked.prompt ? 'held' : null, replyId: null, at: Date.now() })
  while (launches.states.size > 50) launches.states.delete(launches.states.keys().next().value)
  if (checked.prompt) launches.prompts.set(sessionId, { text: checked.prompt, createdAt: Date.now() })
  log(`launched a session in ${path.basename(info.real)}${opts.dryRun ? ' (dry run)' : ''}`)
  return { status: 200, body: { ok: true, sessionId, dryRun: opts.dryRun } }
}

function setPromptState(sessionId, prompt, replyId = null) {
  const state = launches.states.get(sessionId)
  if (state) launches.states.set(sessionId, { ...state, prompt, replyId: replyId ?? state.replyId })
}

export function deliverFirstPrompts(now = Date.now()) {
  for (const [sessionId, pending] of launches.prompts) {
    try {
      if (now - pending.createdAt > FIRST_PROMPT_WAIT_MS) {
        launches.prompts.delete(sessionId)
        setPromptState(sessionId, 'dropped')
        log(`first prompt for session ${sessionId.slice(0, 8)} dropped: the session never reported in`)
        continue
      }
      const record = readJson(path.join(FILES.sessions, `${sessionId}.json`))
      if (!record || record.cliSessionId !== sessionId || !replyQueue) continue
      if (record.replyProtocol !== REPLY_PROTOCOL) {
        launches.prompts.delete(sessionId)
        setPromptState(sessionId, 'dropped')
        log(`first prompt for session ${sessionId.slice(0, 8)} dropped: its Orbit is too old`)
        continue
      }
      const { id } = replyQueue.queue({ cli: sessionId, text: pending.text, firstPrompt: true })
      launches.prompts.delete(sessionId)
      setPromptState(sessionId, 'written', id)
      log(`first prompt ${id} queued for session ${sessionId.slice(0, 8)}`)
    } catch (error) {
      log(`first prompt for session ${sessionId.slice(0, 8)} not written yet: ${error.code ?? error.name}`)
    }
  }
}

export function launchState(sessionId) {
  const state = launches.states.get(sessionId)
  if (!state) return { status: 404, body: { error: 'Orbit no longer tracks this launch.' } }
  if (state.prompt === 'written' && state.replyId) {
    const answer = replyResult(state.replyId)
    if (answer.status === 200 && answer.body.status !== 'pending') setPromptState(sessionId, answer.body.status === 'sent' || answer.body.status === 'queued' ? answer.body.status : 'refused')
    else if (answer.status === 404) setPromptState(sessionId, 'refused')
  }
  return { status: 200, body: { prompt: launches.states.get(sessionId).prompt } }
}
