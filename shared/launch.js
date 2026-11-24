// @ts-check

import { MAX_PROMPT_CHARS } from './constants.js'
import { normalizeFolder } from './links.js'

export const LAUNCH_MODELS = [
  { value: '', label: 'Default' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { value: 'claude-fable-5-2', label: 'Fable 5.2' },
]
const SEEN_MODEL = /^claude-[a-z]+(?:-[0-9]+){1,3}$/
const MAX_SEEN_MODELS = 8
export const LAUNCH_EFFORTS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
]
export const LAUNCH_MODES = [
  { value: '', label: 'Default' },
  { value: 'manual', label: 'Ask' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypassPermissions', label: 'Bypass permissions' },
]
export const LAUNCH_AGAIN_MS = 3_000
export const LAUNCH_START_MS = 60_000
export const FIRST_PROMPT_WAIT_MS = 3 * 60_000
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FOLDER_REFUSED = /[;^%!`]/

/**
 * The models a launch may name: the fixed list, then model ids sessions have
 * used that match a strict `claude-<family>-<n>[-<n>…]` pattern, so a new
 * release is offered without a code change. A seen id only ever becomes the
 * `--model` argv value.
 * @param {readonly unknown[]} seen model ids, newest first
 * @returns {{ value: string, label: string }[]}
 */
export function launchModels(seen) {
  const out = [...LAUNCH_MODELS]
  for (const id of seen) {
    if (out.length >= LAUNCH_MODELS.length + MAX_SEEN_MODELS) break
    if (typeof id === 'string' && id.length <= 60 && SEEN_MODEL.test(id) && !out.some(o => o.value === id)) out.push({ value: id, label: id })
  }
  return out
}

/**
 * @param {readonly { value: string }[]} list
 * @param {unknown} value
 * @returns {value is string}
 */
function isOneOf(list, value) {
  return typeof value === 'string' && list.some(o => o.value === value)
}

/**
 * The folder a terminal session may start in: what `normalizeFolder` accepts,
 * minus characters Windows Terminal or a shell would treat specially.
 * @param {unknown} text
 * @returns {string | null}
 */
export function launchFolder(text) {
  const folder = normalizeFolder(typeof text === 'string' ? text : '')
  return folder && !FOLDER_REFUSED.test(folder) ? folder : null
}

/**
 * A launch request checked against the allow-lists: an accepted folder,
 * a prompt under the limit (never put on a command line), model, effort and
 * mode from the lists, bypassPermissions only with its second confirm, and the
 * digest of the folder check the dialog showed. Orbit never trusts a folder:
 * Claude asks in the new terminal when it is not trusted.
 * @param {unknown} body
 * @param {readonly { value: string }[]} [models] what `launchModels` offers now
 * @returns {{ ok: true, folder: string, prompt: string, model: string, effort: string, mode: string, digest: string } | { ok: false, error: string }}
 */
export function checkLaunch(body, models = LAUNCH_MODELS) {
  const b = /** @type {any} */ (body) ?? {}
  const folder = launchFolder(b.folder)
  if (!folder) return { ok: false, error: 'Enter an absolute local folder, like C:\\repos\\app (no ; ^ % ! or `).' }
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : ''
  if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, error: `Keep the first prompt under ${MAX_PROMPT_CHARS} characters.` }
  const model = b.model ?? ''
  const effort = b.effort ?? ''
  const mode = b.mode ?? ''
  if (!isOneOf(models, model)) return { ok: false, error: 'Pick a model from the list.' }
  if (!isOneOf(LAUNCH_EFFORTS, effort)) return { ok: false, error: 'Pick an effort from the list.' }
  if (!isOneOf(LAUNCH_MODES, mode)) return { ok: false, error: 'Pick a permission mode from the list.' }
  if (mode === 'bypassPermissions' && b.confirmBypass !== true) return { ok: false, error: 'Bypass permissions needs its confirm tick.' }
  const digest = typeof b.digest === 'string' && /^[0-9a-f]{64}$/.test(b.digest) ? b.digest : ''
  if (!digest) return { ok: false, error: 'Check the folder again before starting.' }
  return { ok: true, folder, prompt, model, effort, mode, digest }
}

/**
 * The Windows Terminal command line for a new session, as an argv array:
 * a new window titled for the folder, started in it, running Claude Code
 * with a pre-chosen session id and the chosen flags. The prompt is never in it.
 * @param {{ wt: string, claude: string, folder: string, sessionId: string, model: string, effort: string, mode: string }} o
 * @returns {string[]}
 */
export function launchArgv(o) {
  if (!UUID_V4.test(o.sessionId) || launchFolder(o.folder) !== o.folder) throw new Error('refused launch')
  const name = o.folder.split('\\').filter(Boolean).at(-1) ?? 'folder'
  return [
    o.wt,
    '-w',
    'new',
    '--title',
    `Orbit · ${name}`,
    '-d',
    o.folder,
    '--',
    o.claude,
    '--session-id',
    o.sessionId,
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
    ...(o.mode ? ['--permission-mode', o.mode] : []),
  ]
}

const LAUNCH_ENV_NAMES = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'PUBLIC',
  'ALLUSERSPROFILE',
  'COMPUTERNAME',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'CLAUDE_CODE_PLUGIN_DIRS',
]
const LAUNCH_ENV_KEPT = new Set(LAUNCH_ENV_NAMES.map(n => n.toUpperCase()))

/**
 * The environment a launched session gets: only the standard Windows
 * variables (and `PROCESSOR_*`) plus Orbit's plugin folders, whatever else
 * this process inherited from the Claude session or desktop host that started it.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {{ env: Record<string, string>, removed: string[] }}
 */
export function launchEnv(env) {
  /** @type {Record<string, string>} */
  const out = {}
  /** @type {string[]} */
  const removed = []
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    const name = k.toUpperCase()
    if (LAUNCH_ENV_KEPT.has(name) || name.startsWith('PROCESSOR_')) out[k] = v
    else removed.push(k)
  }
  return { env: out, removed: removed.sort() }
}

/**
 * The newest desktop-bundled Claude Code (`<root>\<version>\<hash>\claude.exe`), by version.
 * @param {readonly { version: string, path: string }[]} found
 * @returns {string | null}
 */
export function newestClaude(found) {
  const parse = (/** @type {string} */ v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null)
  const valid = found.filter(f => parse(f.version) && /^[A-Za-z]:\\.*\\claude\.exe$/i.test(f.path))
  valid.sort((a, b) => {
    const x = /** @type {number[]} */ (parse(a.version))
    const y = /** @type {number[]} */ (parse(b.version))
    return (y[0] ?? 0) - (x[0] ?? 0) || (y[1] ?? 0) - (x[1] ?? 0) || (y[2] ?? 0) - (x[2] ?? 0)
  })
  return valid[0]?.path ?? null
}

/**
 * Whether an `lstat` result can be Windows Terminal: a plain file, or the App
 * Execution Alias it ships as (a reparse point that `existsSync` and `stat` refuse).
 * @param {{ isFile(): boolean, isSymbolicLink(): boolean } | null} lstat
 * @returns {boolean}
 */
export function isRunnable(lstat) {
  return Boolean(lstat && (lstat.isFile() || lstat.isSymbolicLink()))
}

/**
 * Whether an Authenticode result (PowerShell `Get-AuthenticodeSignature`) is a valid signature by Anthropic.
 * @param {unknown} result `{ Status, Subject }`
 * @returns {boolean}
 */
export function isAnthropicSigned(result) {
  const r = /** @type {any} */ (result)
  return r?.Status === 0 || r?.Status === 'Valid' ? /(^|,\s*)O="?Anthropic, PBC"?(,|$)/.test(String(r.Subject ?? '')) : false
}

export const LAUNCH_NEEDS_REPLIES = 'Replies as me are off: turn them on in Settings to start with a first prompt or Bypass permissions.'

/**
 * An Orbit launch acts as the person when it carries a first prompt or skips
 * permission prompts, so it needs Replies as me armed, like a reply.
 * @param {{ prompt: string, mode: string }} launch
 * @returns {boolean}
 */
export function launchNeedsReplies(launch) {
  return launch.prompt !== '' || launch.mode === 'bypassPermissions'
}

/**
 * What the New session dialog lets you do now. Orbit launches need a checked
 * folder; bypassPermissions needs its confirm; a first prompt or bypass needs
 * Replies as me on (`needsReplies`: offer the switch).
 * @param {{ where: 'orbit' | 'desktop', folderState: 'empty' | 'checking' | 'error' | 'ok', isLaunchable: boolean, mode: string, confirmBypass: boolean, isBusy: boolean, hasPrompt: boolean, isRepliesArmed: boolean }} s
 * @returns {{ canStart: boolean, why: string | null, showBypass: boolean, needsReplies: boolean }}
 */
export function launchFormState(s) {
  const isOrbit = s.where === 'orbit'
  const showBypass = isOrbit && s.mode === 'bypassPermissions'
  const needsReplies = isOrbit && !s.isRepliesArmed && launchNeedsReplies({ prompt: s.hasPrompt ? 'x' : '', mode: s.mode })
  /** @type {string | null} */
  let why = null
  if (s.folderState === 'empty') why = 'Pick a folder.'
  else if (s.folderState === 'checking') why = 'Checking folder…'
  else if (s.folderState === 'error') why = null
  else if (isOrbit && !s.isLaunchable) why = 'Orbit will not pass this path to a terminal (; ^ % ! or `); use Claude desktop.'
  else if (needsReplies) why = LAUNCH_NEEDS_REPLIES
  else if (showBypass && !s.confirmBypass) why = 'Confirm bypass permissions first.'
  return { canStart: !s.isBusy && s.folderState === 'ok' && why === null, why, showBypass, needsReplies }
}

/**
 * Launches the page is waiting for, each `starting` until a snapshot session
 * with its id appears (then `arrived` with that session's key), or `failed`
 * after `LAUNCH_START_MS`.
 * @param {readonly { sessionId: string, folder: string, startedAt: number }[]} pending
 * @param {readonly { key: string, cliSessionId: string | null }[]} sessions
 * @param {number} now
 * @returns {{ sessionId: string, folder: string, startedAt: number, status: 'starting' | 'failed' | 'arrived', key: string | null }[]}
 */
export function launchStatus(pending, sessions, now) {
  return pending.map(p => {
    const s = sessions.find(x => x.cliSessionId === p.sessionId)
    if (s) return { ...p, status: /** @type {const} */ ('arrived'), key: s.key }
    return { ...p, status: now - p.startedAt > LAUNCH_START_MS ? /** @type {const} */ ('failed') : /** @type {const} */ ('starting'), key: null }
  })
}

/**
 * Whether the page may select a session that just arrived: only while you are
 * not typing, have not picked something else since you started it, and have no
 * unsent message. Otherwise it is marked unread instead.
 * @param {{ isTyping: boolean, selectedNow: string | null, selectedAtLaunch: string | null, hasDraft: boolean }} s
 * @returns {boolean}
 */
export function mayAutoSelect(s) {
  return !s.isTyping && s.selectedNow === s.selectedAtLaunch && !s.hasDraft
}

/**
 * What the page says after handing a new session to Claude desktop. The link
 * only fills in Claude's new-session page; nothing starts until the person
 * presses Enter there, so the words must never claim a session started.
 * @param {boolean} isDryRun
 * @param {boolean} hasPrompt
 * @param {string} folder
 * @returns {string}
 */
export function desktopOutcome(isDryRun, hasPrompt, folder) {
  if (isDryRun) return 'Dry run: link recorded, not opened.'
  const name = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder
  return hasPrompt
    ? `Prompt handed to Claude desktop (${name}). Not started yet: in Claude, open New session and press Enter.`
    : `Claude desktop asked to open a new session in ${name}. Not started yet: confirm it there.`
}

/**
 * A launched session's first prompt, in words for the page.
 * @param {string | null} state
 * @returns {string | null}
 */
export function promptStateText(state) {
  switch (state) {
    case 'held':
      return 'Prompt waits for the session'
    case 'written':
      return 'Prompt sending…'
    case 'queued':
      return 'Prompt queued'
    case 'sent':
      return 'Prompt sent'
    case 'refused':
    case 'failed':
    case 'dropped':
      return 'Prompt not delivered'
    default:
      return null
  }
}
