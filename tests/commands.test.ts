import { expect, test } from 'claude-code/testing'

import { checkReplyText, COMMAND_MENU_MAX, commandMenu, isCommandAllowed, judgeReply, parseCommand, publishableCommands } from '../shared/inbox.js'
import { commandBlock, REMOTE_SWITCH_WAIT_MS, REPLY_OLDER_TEXT, remoteSwitchState } from '../shared/popout.js'
import { normalizeDesktop } from '../shared/aggregate/desktop.js'
import { NOW, pub, session } from './fixtures'

const ME = 'cli-me'
const ID = '0a1b2c3d-0000-4000-8000-00000000c0de'
const LISTED = new Set(['compact', 'review', 'remote-control', 'config'])
const cmd = (name: string) => ({ name, description: `About ${name}`, source: 'builtin' })

test('a reply that is a slash command splits into its name and its arguments; anything else is not a command', () => {
  expect(parseCommand('/review the auth module')).toEqual({ name: 'review', args: 'the auth module' })
  expect(parseCommand('/compact')).toEqual({ name: 'compact', args: '' })
  expect(parseCommand('/plugin:skill go')).toEqual({ name: 'plugin:skill', args: 'go' })
  expect([parseCommand('use a/b paths'), parseCommand('/'), parseCommand('!ls'), parseCommand('# note')]).toEqual([null, null, null, null])
})

test('Orbit runs a slash command only when the session lists it and it is not on the deny-list; ! and # never', () => {
  expect(checkReplyText('/compact keep the plan', LISTED)).toEqual({ ok: true, text: '/compact keep the plan', command: { name: 'compact', args: 'keep the plan' } })
  expect(checkReplyText('/config', LISTED)).toMatchObject({ ok: false, reason: 'command' })
  expect(checkReplyText('/made-up', LISTED)).toMatchObject({ ok: false, reason: 'command', error: '/made-up is not a command this session has.' })
  expect(checkReplyText('/compact', null)).toMatchObject({ ok: false, reason: 'command' })
  expect(checkReplyText('!ls', LISTED)).toMatchObject({ ok: false, reason: 'command' })
  expect(checkReplyText('# remember this', LISTED)).toMatchObject({ ok: false, reason: 'command' })
  expect(['login', 'Permissions', 'hooks', 'mcp', 'memory'].map(isCommandAllowed)).toEqual([false, false, false, false, false])
  expect(['compact', 'remote-control', 'review'].map(isCommandAllowed)).toEqual([true, true, true])
})

test('a session publishes the hidden /remote-control and /rename once, deny-listed commands never', () => {
  expect(publishableCommands([cmd('compact'), cmd('config')]).map(c => c.name)).toEqual(['compact', 'remote-control', 'rename'])
  expect(publishableCommands([cmd('remote-control'), cmd('rename')])).toEqual([cmd('remote-control'), cmd('rename')])
})

test('a command reply always waits for the turn to end, whatever the page asked', () => {
  const raw = { schema: 1, id: ID, to: ME, text: '/compact', createdAt: NOW - 1_000, wait: false }
  expect(judgeReply(raw, { me: ME, now: NOW, seen: new Set(), commands: LISTED })).toEqual({ kind: 'deliver', id: ID, text: '/compact', held: false, wait: true, command: { name: 'compact', args: '' } })
  expect(judgeReply(raw, { me: ME, now: NOW, seen: new Set() })).toEqual({ kind: 'refuse', id: ID, reason: 'command' })
})

test('the / menu lists matches by prefix, then by contains, capped; it says why when nothing can be sent', () => {
  const list = ['review', 'compact', 'remote-control', 'pr-comments', 'release-notes'].map(cmd)
  expect(commandMenu('/re', list)?.items.map(c => c.name)).toEqual(['release-notes', 'remote-control', 'review'])
  expect(commandMenu('/com', list)?.items.map(c => c.name)).toEqual(['compact', 'pr-comments'])
  expect(commandMenu('/', list)?.items.map(c => c.name)).toEqual(['compact', 'pr-comments', 'release-notes', 'remote-control', 'review'])
  expect(commandMenu('/', Array.from({ length: 20 }, (_, i) => cmd(`c${i}`)))?.items.length).toBe(COMMAND_MENU_MAX)
  expect([commandMenu('/re view', list), commandMenu('hello', list), commandMenu('', list)]).toEqual([null, null, null])
  expect(commandMenu('/re', null)?.hint).toContain('has not heard')
  expect(commandMenu('/config', list)).toEqual({ items: [], hint: '/config changes settings or access, so Orbit never runs it: open the session for it.' })
  expect(commandMenu('/nope', list)?.hint).toBe('No command named /nope in this session.')
  expect(commandMenu('/', [])?.hint).toBe('This session lists no commands Orbit may run.')
})

const ready = (patch = {}) => session('local_a', { remoteControl: false, canMessage: true, publisher: pub({ replyProtocol: 2 } as never), ...patch })
const context = (patch = {}) => ({ armed: true, listed: true as boolean | null, pending: null as { from: boolean; at: number } | null, now: NOW, ...patch })

test('the Remote Control switch can be pressed only when the state is known, replies are armed and the session lists /remote-control', () => {
  expect(remoteSwitchState(ready(), context())).toEqual({ on: false, disabled: false, reason: null, note: null, settled: false })
  expect(remoteSwitchState(ready({ remoteControl: true }), context()).on).toBe(true)
  expect(remoteSwitchState(ready({ remoteControl: null }), context()).reason).toContain('cannot read')
  expect(remoteSwitchState(ready({ publisher: pub() }), context()).reason).toBe(REPLY_OLDER_TEXT)
  expect(remoteSwitchState(ready(), context({ armed: false })).reason).toContain('Replies as me')
  expect(remoteSwitchState(ready(), context({ listed: null })).reason).toContain('not heard')
  expect(remoteSwitchState(ready(), context({ listed: false })).reason).toBe('This session does not list /remote-control.')
  for (const st of [remoteSwitchState(ready({ remoteControl: null }), context()), remoteSwitchState(ready(), context({ armed: false }))]) expect(st.disabled).toBe(true)
})

test('a press shows Switching… until the desktop record flips, and gives up after its wait with a pointer to the session', () => {
  const pending = { from: false, at: NOW - 1_000 }
  expect(remoteSwitchState(ready(), context({ pending }))).toMatchObject({ disabled: true, note: 'Switching…', settled: false })
  expect(remoteSwitchState(ready({ remoteControl: true }), context({ pending }))).toMatchObject({ on: true, disabled: false, note: null, settled: true })
  expect(remoteSwitchState(ready(), context({ pending, now: pending.at + REMOTE_SWITCH_WAIT_MS }))).toMatchObject({ disabled: false, note: 'No change: open the session to switch it there.', settled: true })
})

test('Remote Control from the desktop record: its user switch when set, off when only eligibility is recorded, unknown otherwise', () => {
  const read = (patch: Record<string, unknown>) => normalizeDesktop({ sessionId: 'local_0a1b2c3d-0000-4000-8000-000000000001', lastTurnEdgeAt: NOW - 60_000, ...patch } as never, NOW, new Set())?.remoteControl
  expect(read({ remoteControlUserEnabled: true, remoteControlAutoEligible: false })).toBe(true)
  expect(read({ remoteControlUserEnabled: false, remoteControlAutoEligible: true })).toBe(false)
  expect(read({ remoteControlAutoEligible: true })).toBe(false)
  expect(read({})).toBe(null)
  expect(read({ remoteControlUserEnabled: 'yes' })).toBe(null)
})

test('Orbit sends /rename only to a session that takes replies as me and lists the command', () => {
  const rename = (patch = {}) => ({ armed: true, listed: true as boolean | null, name: 'rename', doing: 'rename it in Claude too', ...patch })
  expect(commandBlock(ready(), rename())).toBe(null)
  expect(commandBlock(ready({ publisher: pub() }), rename())).toBe(REPLY_OLDER_TEXT)
  expect(commandBlock(ready(), rename({ armed: false }))).toBe('Turn on Replies as me in Settings to rename it in Claude too.')
  expect(commandBlock(ready(), rename({ listed: null }))).toContain('not heard')
  expect(commandBlock(ready(), rename({ listed: false }))).toBe('This session does not list /rename.')
})
