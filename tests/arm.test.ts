import { expect, test } from 'claude-code/testing'

import { alertText, ARMED_LEAD, armedCapabilities, armSetupLine, attentionPost, auditText, isTypingDue, replyRefusal, sendMode, settingsName } from '../shared/popout.js'
import type { SessionView } from '../types'

const NOW = 1_700_000_000_000
const DAY = 86_400_000
const WINDOW = '0123456789abcdef'

test('A5: every armed capability gets an always-visible chip naming it, in a fixed order, under one lead that says remote control is on in every window', () => {
  expect(armedCapabilities({ approvals: false, questions: false, replies: false })).toEqual([])
  expect(armedCapabilities({ approvals: true, questions: true, replies: true }).map(c => [c.key, c.label, c.control])).toEqual([
    ['approvals', 'Approvals', 's-arm-approvals'],
    ['questions', 'Questions', 's-arm-questions'],
    ['replies', 'Replies as me', 's-arm-replies'],
  ])
  expect(ARMED_LEAD).toBe('Remote control on, all windows:')
})

test('2.1.2 A5: the Settings button names what remote control has on, and is plain "Settings" with nothing armed', () => {
  expect(settingsName(armedCapabilities({ approvals: false, questions: false, replies: false }))).toBe('Settings')
  expect(settingsName(armedCapabilities({ approvals: true, questions: true, replies: false }))).toBe('Settings · Remote control on: Approvals, Questions')
  expect(settingsName(armedCapabilities({ approvals: false, questions: false, replies: true }))).toBe('Settings · Remote control on: Replies as me')
})

const session = (replyProtocol: number | undefined): SessionView => ({ key: 'local_a', publisher: replyProtocol === undefined ? null : { replyProtocol, endedAt: null } }) as unknown as SessionView

test('A5: a session takes replies only with reply protocol 2; armed replies are what turns the composer on', () => {
  expect(sendMode(session(2), true)).toBe('reply')
  expect(sendMode(session(2), false)).toBe('off')
  expect(sendMode(session(1), true)).toBe('older')
  expect(sendMode(session(undefined), true)).toBe('older')
})

test('A5 E-25: each capability says what it still needs to work', () => {
  const setup = { hookSeenAt: null, replySessions: 3, olderSessions: 1 }
  expect(armSetupLine('approvals', setup, NOW)).toBe('The approval hook has not called in yet: install it to use this.')
  expect(armSetupLine('questions', { ...setup, hookSeenAt: NOW - 8 * DAY }, NOW)).toBe('The approval hook has not called in yet: install it to use this.')
  expect(armSetupLine('approvals', { ...setup, hookSeenAt: NOW - DAY }, NOW)).toBe(null)
  expect(armSetupLine('replies', setup, NOW)).toBe('3 sessions can take replies; 1 runs an older Orbit.')
  expect(armSetupLine('replies', { ...setup, replySessions: 1, olderSessions: 0 }, NOW)).toBe('1 session can take replies.')
})

test('A5: a reply refused because replies are off says so and points at the switch; an older session keeps its line', () => {
  expect(replyRefusal(409, { reason: 'not-armed', error: 'x' })).toEqual({ text: 'Not sent: replies are off. Turn on Replies as me in Settings.', isNotArmed: true })
  expect(replyRefusal(409, { older: true })).toEqual({ text: 'Not sent: this session’s Orbit is too old for replies. Open it in Claude.', isNotArmed: false })
  expect(replyRefusal(500, { error: 'boom' })).toBe(null)
})

test('A5 E-116: the attention post says whether the window has focus, and a focus change is posted', () => {
  expect(attentionPost(true, WINDOW, null, null, true)).toEqual({ attentive: true, windowId: WINDOW, selected: null, focused: true })
  const idle = { attentive: false, windowId: WINDOW, selected: null, focused: false }
  expect(attentionPost(false, WINDOW, idle, null, false)).toBe(null)
  expect(attentionPost(false, WINDOW, idle, null, true)).toEqual({ attentive: false, windowId: WINDOW, selected: null, focused: true })
})

test('A5 E-23: a question being typed is reported at most every 10 s', () => {
  expect(isTypingDue(null, NOW)).toBe(true)
  expect(isTypingDue(NOW - 9_999, NOW)).toBe(false)
  expect(isTypingDue(NOW - 10_000, NOW)).toBe(true)
})

test('A5 E-22: alerts read as one plain line, by kind and folder, never content', () => {
  expect(alertText({ kind: 'forged-file', where: 'approvals', what: 'request', at: NOW })).toBe('Orbit deleted a file in its approvals folder that it did not write; nothing was approved or sent.')
  expect(alertText({ kind: 'forged-file', where: 'inbox', what: 'reply', at: NOW })).toBe('Orbit deleted a file in its inbox folder that it did not write; nothing was sent.')
  expect(alertText({ kind: 'tampered', where: 'arm', what: 'tampered', at: NOW })).toBe('The arm settings failed their check, so every switch is off. Turn back on what you want in Settings.')
  expect(alertText({ kind: 'forged-file', where: 'window', what: 'link-reused', at: NOW })).toBe('This window’s link was used somewhere else, so Orbit locked it: open Pop out again.')
})

test('A5: an audit entry reads as kind, subject and outcome', () => {
  expect(auditText({ kind: 'arm', capability: 'replies', armed: true, at: NOW })).toBe('Replies as me turned on')
  expect(auditText({ kind: 'arm', capability: 'approvals', armed: true, outcome: 'restored at start', at: NOW })).toBe('Approvals turned on · restored at start')
  expect(auditText({ kind: 'approval', session: 'local_a', tool: 'Bash', outcome: 'allow', at: NOW })).toBe('Approval · Bash · allow')
  expect(auditText({ kind: 'reply', session: 'cli:x', outcome: 'delivered', at: NOW })).toBe('Reply · delivered')
  expect(auditText({ kind: 'alert', where: 'inbox', what: 'reply', at: NOW })).toBe('Alert · inbox · reply')
})
