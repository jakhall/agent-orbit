import { expect, test } from 'claude-code/testing'

import type { ConversationRow, SessionView } from '../types'
import { DRAFT_SESSIONS, draftOf, isConversationWanted, isReplyWanted, replyQuote, setDraft, switcherResults, switcherRowMeta, switcherStatus, type Send } from '../shared/popout.js'
import { NOW, session } from './fixtures'

const needsYou = (key: string, patch: Partial<SessionView> = {}) => session(key, { lifecycle: 'waiting-permission', attention: 'permission', ...patch })
const sending = (key: string, status: Send['status']): Send => ({ key, draft: `Text for ${key}`, status, message: null })

test("a draft stays with its own session: another session's box never shows it, and discarding clears only that session's", () => {
  const drafts = new Map<string, string>()
  setDraft(drafts, 'local_a', 'Reply to A')
  setDraft(drafts, 'local_b', 'Note for B')
  expect(draftOf(drafts, 'local_a')).toBe('Reply to A')
  expect(draftOf(drafts, 'local_c')).toBe('')
  setDraft(drafts, 'local_a', '')
  expect(draftOf(drafts, 'local_a')).toBe('')
  expect(draftOf(drafts, 'local_b')).toBe('Note for B')
})

test('drafts are kept for the 12 most recently typed-in sessions; typing again makes a draft recent', () => {
  const drafts = new Map<string, string>()
  for (let i = 0; i < DRAFT_SESSIONS; i += 1) setDraft(drafts, `local_${i}`, `draft ${i}`)
  setDraft(drafts, 'local_0', 'draft 0, edited')
  setDraft(drafts, 'local_new', 'one more')
  expect(drafts.size).toBe(DRAFT_SESSIONS)
  expect(draftOf(drafts, 'local_0')).toBe('draft 0, edited')
  expect(draftOf(drafts, 'local_1')).toBe('')
  expect(draftOf(drafts, 'local_new')).toBe('one more')
})

test("the reply quotes Claude's last reply or question after your last prompt, and nothing when Claude has not answered since", () => {
  const row = (who: ConversationRow['who'], text: string): ConversationRow => ({ who, at: NOW, text })
  expect(replyQuote([row('you', 'Fix it'), row('claude', 'First'), row('tools', 'Ran tests · 1 tool'), row('claude', 'Done. Commit?')])?.text).toBe('Done. Commit?')
  expect(replyQuote([row('you', 'Ship it?'), row('claude', 'Checking'), row('question', 'Which branch?')])?.who).toBe('question')
  expect(replyQuote([row('claude', 'Earlier answer'), row('you', 'New prompt')])).toBe(null)
  expect(replyQuote([row('claude', 'Earlier answer'), row('you', 'New prompt'), row('tools', 'Read a.ts · 1 tool')])).toBe(null)
  expect(replyQuote([])).toBe(null)
})

test('a reply is offered only to a session that needs you, takes messages and has a transcript; the conversation loads for any session with a transcript while its text is shown', () => {
  const waiting = needsYou('local_w')
  expect(isReplyWanted(waiting)).toBe(true)
  expect(isReplyWanted({ ...waiting, canMessage: false })).toBe(false)
  expect(isReplyWanted({ ...waiting, cliSessionId: null })).toBe(false)
  expect(isReplyWanted(session('local_idle'))).toBe(false)
  expect(isReplyWanted(session('local_rev', { attention: 'review' }))).toBe(false)
  expect(isConversationWanted(waiting, true)).toBe(true)
  expect(isConversationWanted(waiting, false)).toBe(false)
  expect(isConversationWanted(session('local_idle'), false)).toBe(false)
  expect(isConversationWanted(session('local_idle'), true)).toBe(true)
  expect(isConversationWanted(session('local_idle', { cliSessionId: null }), true)).toBe(false)
})

test('the switcher puts hidden matches after the rest, counts every match, and each row says where the session is and why Orbit is not showing it', () => {
  const shown = session('local_shown', { title: 'Fix the login form' })
  const hiddenOne = session('local_hidden', { title: 'Login page polish', lastActivityAt: NOW - 120_000 })
  const other = session('local_other', { title: 'Docs' })
  const hidden = { local_hidden: NOW - 120_000 }
  const project = () => 'app'
  const results = switcherResults([hiddenOne, other, shown], hidden, 'login', project, [])
  expect(results.items.map(s => s.key)).toEqual(['local_shown', 'local_hidden'])
  expect([results.total, results.hidden]).toEqual([2, 1])
  const capped = switcherResults([hiddenOne, other, shown], hidden, 'login', project, [], 1)
  expect([capped.items.length, capped.total]).toEqual([1, 2])
  expect(switcherResults([hiddenOne, other, shown], hidden, '', project, []).items.at(-1)?.key).toBe('local_hidden')

  expect(switcherRowMeta(shown, 'app', NOW, { isHidden: false, isListed: true })).toEqual({ meta: 'app · main · 1m', tag: null })
  expect(switcherRowMeta({ ...shown, branch: null }, 'app', NOW, { isHidden: false, isListed: false })).toEqual({ meta: 'app · 1m', tag: 'Filtered' })
  expect(switcherRowMeta(hiddenOne, '', NOW, { isHidden: true, isListed: false })).toEqual({ meta: 'main · 2m', tag: 'Hidden' })

  expect(switcherStatus(0, 0)).toBe('No sessions match')
  expect(switcherStatus(1, 0)).toBe('1 session')
  expect(switcherStatus(3, 1)).toBe('3 sessions · 1 hidden')
})
