import { expect, test } from 'claude-code/testing'

import {
  checkLaunch,
  desktopOutcome,
  isAnthropicSigned,
  isRunnable,
  LAUNCH_EFFORTS,
  LAUNCH_MODELS,
  LAUNCH_MODES,
  LAUNCH_START_MS,
  launchArgv,
  launchEnv,
  launchFolder,
  launchFormState,
  LAUNCH_NEEDS_REPLIES,
  launchNeedsReplies,
  launchStatus,
  mayAutoSelect,
  newestClaude,
  promptStateText,
} from '../shared/launch.js'
import { NOW } from './fixtures'

const ID = '0a1b2c3d-0000-4000-8000-0000000000c1'
const DIGEST = 'd'.repeat(64)
const ok = { folder: 'C:\\repos\\app', prompt: 'hi', model: 'claude-haiku-5-5', effort: 'high', mode: 'plan', digest: DIGEST }

test('the option lists are the allow-lists; Ask is the CLI mode manual', () => {
  expect(LAUNCH_MODELS.map(o => o.value)).toEqual(['', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'])
  expect(LAUNCH_EFFORTS.map(o => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max'])
  expect(LAUNCH_MODES.map(o => o.value)).toEqual(['', 'manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
  expect(LAUNCH_MODES.find(o => o.value === 'manual')?.label).toBe('Ask')
  expect(checkLaunch({ ...ok, mode: 'default' }).ok).toBe(false)
})

test('a launch is checked against the lists, needs the review digest, and bypass needs its confirm', () => {
  expect(checkLaunch(ok)).toEqual({ ok: true, folder: 'C:\\repos\\app', prompt: 'hi', model: 'claude-haiku-5-5', effort: 'high', mode: 'plan', digest: DIGEST })
  for (const bad of [{ ...ok, model: 'gpt-4' }, { ...ok, effort: 'ultra' }, { ...ok, mode: 'yolo' }, { ...ok, model: '--dangerously-skip-permissions' }, { ...ok, prompt: 'x'.repeat(4001) }, { ...ok, mode: 'bypassPermissions' }, { ...ok, digest: undefined }, { ...ok, digest: 'x' }]) {
    expect(checkLaunch(bad).ok).toBe(false)
  }
  expect(checkLaunch({ ...ok, mode: 'bypassPermissions', confirmBypass: true }).ok).toBe(true)
  const loose = checkLaunch({ ...ok, trust: true })
  expect(loose.ok && Object.hasOwn(loose, 'trust')).toBe(false)
  for (const folder of ['relative\\x', '\\\\nas\\share', 'C:\\a;b', 'C:\\a^b', 'C:\\%TEMP%', 'C:\\a!b', 'C:\\a`b', 'C:\\x\\..\\y', 'C:\\a"b']) {
    expect(launchFolder(folder)).toBeNull()
    expect(checkLaunch({ ...ok, folder }).ok).toBe(false)
  }
  expect(launchFolder('C:\\R&D\\my app')).toBe('C:\\R&D\\my app')
})

test('the terminal argv starts Claude with the session id and flags only; the prompt is never on it', () => {
  const argv = launchArgv({ wt: 'C:\\wt.exe', claude: 'C:\\c\\claude.exe', folder: 'C:\\repos\\my app', sessionId: ID, model: 'claude-haiku-5-5', effort: 'high', mode: 'manual' })
  expect(argv).toEqual(['C:\\wt.exe', '-w', 'new', '--title', 'Orbit · my app', '-d', 'C:\\repos\\my app', '--', 'C:\\c\\claude.exe', '--session-id', ID, '--model', 'claude-haiku-5-5', '--effort', 'high', '--permission-mode', 'manual'])
  expect(launchArgv({ wt: 'wt', claude: 'claude', folder: 'C:\\r', sessionId: ID, model: '', effort: '', mode: '' })).toEqual(['wt', '-w', 'new', '--title', 'Orbit · r', '-d', 'C:\\r', '--', 'claude', '--session-id', ID])
  expect(() => launchArgv({ wt: 'wt', claude: 'claude', folder: 'C:\\a;b', sessionId: ID, model: '', effort: '', mode: '' })).toThrow()
  expect(() => launchArgv({ wt: 'wt', claude: 'claude', folder: 'C:\\r', sessionId: 'not-an-id', model: '', effort: '', mode: '' })).toThrow()
})

test('a launched session gets only standard Windows variables and the plugin folders', () => {
  const { env, removed } = launchEnv({
    Path: 'C:\\bin',
    SystemRoot: 'C:\\Windows',
    PROCESSOR_ARCHITECTURE: 'AMD64',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    CLAUDE_CODE_PLUGIN_DIRS: 'C:\\mods',
    CLAUDECODE: '1',
    CLAUDE_CODE_MESSAGING_TOKEN: 'x',
    CLAUDE_CODE_SANDBOXED: '1',
    CLAUDE_CONFIG_DIR: 'C:\\cfg',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    NODE_OPTIONS: '--require x',
    BAGGAGE: 'trace',
    GIT_EDITOR: 'x',
  })
  expect(Object.keys(env).sort()).toEqual(['CLAUDE_CODE_PLUGIN_DIRS', 'PROCESSOR_ARCHITECTURE', 'Path', 'ProgramFiles(x86)', 'SystemRoot'])
  expect(removed).toEqual(['ANTHROPIC_BASE_URL', 'BAGGAGE', 'CLAUDECODE', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SANDBOXED', 'CLAUDE_CONFIG_DIR', 'GIT_EDITOR', 'NODE_OPTIONS'])
})

test('Windows Terminal is found as an App Execution Alias; the bundled Claude must be the newest version and signed by Anthropic', () => {
  const stat = (file: boolean, link: boolean) => ({ isFile: () => file, isSymbolicLink: () => link })
  expect([isRunnable(stat(false, true)), isRunnable(stat(true, false)), isRunnable(stat(false, false)), isRunnable(null)]).toEqual([true, true, false, false])
  expect(newestClaude([{ version: '2.1.9', path: 'C:\\a\\2.1.9\\h\\claude.exe' }, { version: '2.1.317', path: 'C:\\a\\2.1.317\\h\\claude.exe' }, { version: '2.1.40', path: 'C:\\a\\2.1.40\\h\\claude.exe' }, { version: 'latest', path: 'C:\\a\\latest\\h\\claude.exe' }])).toBe('C:\\a\\2.1.317\\h\\claude.exe')
  const subject = 'CN="Anthropic, PBC", O="Anthropic, PBC", L=San Francisco, S=California, C=US'
  expect([isAnthropicSigned({ Status: 0, Subject: subject }), isAnthropicSigned({ Status: 'Valid', Subject: subject })]).toEqual([true, true])
  expect([isAnthropicSigned({ Status: 1, Subject: subject }), isAnthropicSigned({ Status: 0, Subject: 'CN=Evil, O=Evil Corp' }), isAnthropicSigned({ Status: 0, Subject: 'CN=x, O="Anthropic, PBC Ltd"' }), isAnthropicSigned(null)]).toEqual([false, false, false, false])
})

test('the dialog: a checked folder starts; checking or errors do not; bypass needs its confirm; the desktop route has no bypass confirm', () => {
  const base = { where: 'orbit' as const, folderState: 'ok' as const, isLaunchable: true, mode: '', confirmBypass: false, isBusy: false, hasPrompt: false, isRepliesArmed: true }
  expect(launchFormState(base)).toEqual({ canStart: true, why: null, showBypass: false, needsReplies: false })
  expect(launchFormState({ ...base, folderState: 'checking' })).toEqual({ canStart: false, why: 'Checking folder…', showBypass: false, needsReplies: false })
  expect(launchFormState({ ...base, folderState: 'error' })).toEqual({ canStart: false, why: null, showBypass: false, needsReplies: false })
  expect(launchFormState({ ...base, folderState: 'empty' }).canStart).toBe(false)
  expect(launchFormState({ ...base, isLaunchable: false }).canStart).toBe(false)
  expect(launchFormState({ ...base, mode: 'bypassPermissions' })).toEqual({ canStart: false, why: 'Confirm bypass permissions first.', showBypass: true, needsReplies: false })
  expect(launchFormState({ ...base, mode: 'bypassPermissions', confirmBypass: true }).canStart).toBe(true)
  expect(launchFormState({ ...base, where: 'desktop', mode: 'bypassPermissions' })).toEqual({ canStart: true, why: null, showBypass: false, needsReplies: false })
  expect(launchFormState({ ...base, isBusy: true }).canStart).toBe(false)
})

test('the dialog: a first prompt or bypass from Orbit needs Replies as me on; a plain launch and the desktop route do not', () => {
  const off = { where: 'orbit' as const, folderState: 'ok' as const, isLaunchable: true, mode: '', confirmBypass: false, isBusy: false, hasPrompt: false, isRepliesArmed: false }
  expect(launchFormState(off)).toEqual({ canStart: true, why: null, showBypass: false, needsReplies: false })
  expect(launchFormState({ ...off, hasPrompt: true })).toEqual({ canStart: false, why: LAUNCH_NEEDS_REPLIES, showBypass: false, needsReplies: true })
  expect(launchFormState({ ...off, mode: 'bypassPermissions', confirmBypass: true })).toEqual({ canStart: false, why: LAUNCH_NEEDS_REPLIES, showBypass: true, needsReplies: true })
  expect(launchFormState({ ...off, hasPrompt: true, isRepliesArmed: true }).canStart).toBe(true)
  expect(launchFormState({ ...off, hasPrompt: true, where: 'desktop' }).canStart).toBe(true)
  expect([launchNeedsReplies({ prompt: '', mode: 'default' }), launchNeedsReplies({ prompt: 'go', mode: '' }), launchNeedsReplies({ prompt: '', mode: 'bypassPermissions' })]).toEqual([false, true, true])
})

test('a launch waits as Starting, arrives, or did not start; it is selected only when that interrupts nothing', () => {
  const pending = [{ sessionId: ID, folder: 'C:\\r', startedAt: NOW }]
  expect(launchStatus(pending, [], NOW + 1_000).map(r => r.status)).toEqual(['starting'])
  expect(launchStatus(pending, [{ key: `cli:${ID}`, cliSessionId: ID }], NOW + 1_000).map(r => [r.status, r.key])).toEqual([['arrived', `cli:${ID}`]])
  expect(launchStatus(pending, [], NOW + LAUNCH_START_MS + 1).map(r => r.status)).toEqual(['failed'])
  const calm = { isTyping: false, selectedNow: 's:a', selectedAtLaunch: 's:a', hasDraft: false }
  expect([mayAutoSelect(calm), mayAutoSelect({ ...calm, isTyping: true }), mayAutoSelect({ ...calm, selectedNow: 's:b' }), mayAutoSelect({ ...calm, hasDraft: true })]).toEqual([true, false, false, false])
  expect(['held', 'written', 'sent', 'queued', 'refused', 'dropped', null].map(promptStateText)).toEqual(['Prompt waits for the session', 'Prompt sending…', 'Prompt sent', 'Prompt queued', 'Prompt not delivered', 'Prompt not delivered', null])
})

test('the desktop route never says a session started: it names the folder and what to do in Claude', () => {
  expect(desktopOutcome(true, true, 'C:\\repo\\app')).toBe('Dry run: link recorded, not opened.')
  expect(desktopOutcome(false, true, 'C:\\repo\\app\\')).toBe('Prompt handed to Claude desktop (app). Not started yet: in Claude, open New session and press Enter.')
  expect(desktopOutcome(false, false, 'C:\\repo\\app')).toBe('Claude desktop asked to open a new session in app. Not started yet: confirm it there.')
})
