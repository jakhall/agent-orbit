import { expect, test } from 'claude-code/testing'

import { DEFAULT_FILTERS, DEFAULT_SETTINGS, MAX_HIDDEN } from '../shared/constants.js'
import { CONVERSATION_ROW_CHARS, CONVERSATION_ROWS, transcriptName } from '../shared/conversation.js'
import { isHiddenNow, rankSessions, visibleOf } from '../shared/filters.js'
import { sanitizePrefs } from '../src/core/prefs'
import { buildSnapshot, NOW, rowsOfTranscript, session } from './fixtures'

const at = (s: number) => new Date(NOW + s * 1000).toISOString()
const line = (value: unknown) => JSON.stringify(value)
const user = (content: unknown, s: number, extra: Record<string, unknown> = {}) => line({ type: 'user', timestamp: at(s), message: { role: 'user', content }, ...extra })
const assistant = (content: unknown[], s: number, extra: Record<string, unknown> = {}) => line({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', content }, ...extra })
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: `t-${name}`, name, input })

test('the conversation keeps prompts and replies, folds tool calls into one redacted line, drops results, thinking and bookkeeping', () => {
  const transcript = [
    line({ type: 'file-history-snapshot', snapshot: {} }),
    user('Fix the login bug', 1),
    assistant([{ type: 'thinking', thinking: 'SECRET-THOUGHT about the plan' }], 2),
    assistant([{ type: 'text', text: 'Looking at the auth code.' }], 3),
    assistant([toolUse('Read', { file_path: 'C:\\repo\\src\\auth.ts' })], 4),
    user([{ type: 'tool_result', tool_use_id: 't-Read', content: 'SECRET-OUTPUT file body' }], 5),
    assistant([toolUse('Edit', { file_path: 'C:\\repo\\src\\auth.ts', old_string: 'SECRET-OLD', new_string: 'SECRET-NEW' })], 6),
    assistant([toolUse('Bash', { command: 'API_KEY=SECRET-KEY npm test -- --grep login' })], 7),
    user([{ type: 'tool_result', tool_use_id: 't-Bash', content: 'SECRET-TEST-LOG' }], 8),
    assistant([toolUse('Bash', { command: 'npm test' })], 9),
    line({ type: 'system', content: 'SECRET-SYSTEM' }),
    assistant([{ type: 'text', text: 'SECRET-SIDECHAIN' }], 10, { isSidechain: true }),
    user('<local-command-caveat>SECRET-CAVEAT</local-command-caveat>', 11),
    user('SECRET-META', 11, { isMeta: true }),
    '{"type":"assistant","message":{"content":[{"type":"text","text":"half a line',
    assistant([{ type: 'text', text: 'Fixed: the token check was inverted.' }], 12),
    user('<command-message>review</command-message>\n<command-name>/review</command-name>', 13),
  ].join('\n')
  const { rows, turns } = rowsOfTranscript(transcript)
  expect(rows.map(r => [r.who, r.text])).toEqual([
    ['you', 'Fix the login bug'],
    ['claude', 'Looking at the auth code.'],
    ['tools', 'Read auth.ts, edited auth.ts, ran tests · 4 tools'],
    ['claude', 'Fixed: the token check was inverted.'],
    ['you', '/review'],
  ])
  expect(rows[0]?.at).toBe(NOW + 1000)
  expect(turns).toBe(2)
  expect(JSON.stringify(rows)).not.toContain('SECRET')
})

test('a question Claude asks you becomes its own row with its option labels; other tool input stays hidden', () => {
  const transcript = [
    user('Ship it?', 1),
    assistant([toolUse('Bash', { command: 'git push SECRET-REMOTE' })], 2),
    assistant(
      [toolUse('AskUserQuestion', { questions: [{ question: 'Which branch should I push?', header: 'Branch', options: [{ label: 'main', description: 'SECRET-DESC' }, { label: 'release' }] }] })],
      3,
    ),
  ].join('\n')
  const { rows } = rowsOfTranscript(transcript)
  expect(rows.map(r => [r.who, r.text])).toEqual([
    ['you', 'Ship it?'],
    ['tools', 'Ran git push · 1 tool'],
    ['question', 'Which branch should I push?\n- main\n- release'],
  ])
  expect(JSON.stringify(rows)).not.toContain('SECRET')
})

test('2.4.2: an answered question shows each question with its answer, as Claude desktop records it; an unanswered one keeps its options (Jak 2026-11-25)', () => {
  const ask = { questions: [{ question: 'Which branch?', header: 'Branch', options: [{ label: 'main', description: 'SECRET-DESC' }, { label: 'release' }, { label: 'dev' }] }, { question: 'Tag it?', header: 'Tag', options: [{ label: 'Yes' }, { label: 'No' }] }] }
  const result = (answers: unknown) => line({ type: 'user', timestamp: new Date(NOW + 4000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'SECRET-RESULT' }] }, toolUseResult: { questions: ask.questions, answers } })
  const asked = assistant([{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: ask }], 3)
  const rowsWith = (...more: string[]) => rowsOfTranscript([user('Ship it?', 1), asked, ...more].join('\n')).rows.filter(r => r.who === 'question')
  expect(rowsWith().map(r => [r.text, r.answered])).toEqual([['Which branch?\n- main\n- release\n- dev\n\nTag it?\n- Yes\n- No', undefined]])
  expect(rowsWith(result({ 'Which branch?': 'release', 'Tag it?': 'No, *not yet*' })).map(r => [r.text, r.answered])).toEqual([['Which branch?\n→ **release**\n\nTag it?\n→ **No, not yet**', true]])
  expect(rowsWith(result({ 'Which branch?': 'dev' }))[0]?.text).toBe('Which branch?\n→ **dev**\n\nTag it?')
  expect(rowsWith(result({ 'Which branch?': 'main (Recommended)' }))[0]?.text).toBe('Which branch?\n→ **main**\n\nTag it?')
  expect(rowsWith(result({}))[0]?.answered).toBeUndefined()
  const dismissed = '[User did not answer this question — they sent a message instead. Treat that message as their response; do not re-ask.]'
  expect(rowsWith(result({ 'Which branch?': dismissed, 'Tag it?': dismissed }))[0]?.answered).toBeUndefined()
  expect(JSON.stringify(rowsWith(result({ 'Which branch?': 'dev' })))).not.toContain('SECRET')
})

test("the app's wrapper tags are unwrapped or dropped by name, and a prompt that merely starts with < is kept", () => {
  const text = (prompt: string) => rowsOfTranscript(user(prompt, 1)).rows.map(r => r.text)
  expect(text('<div> layout is broken')).toEqual(['<div> layout is broken'])
  expect(text('<ide_opened_file>The user opened C:\\repo\\SECRET.ts in the IDE.</ide_opened_file>Why does this fail?')).toEqual(['Why does this fail?'])
  expect(text('<pasted_content>SECRET paste</pasted_content>\nSummarise this')).toEqual(['(pasted text)\nSummarise this'])
  expect(text('<channel source="slack">SECRET from someone else</channel>')).toEqual([])
  expect(text('<task-notification>SECRET</task-notification>')).toEqual([])
  expect(text('<system-reminder>SECRET unclosed')).toEqual([])
  expect(text('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>the auth module</command-args>')).toEqual(['/review the auth module'])
  expect(text('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args></command-args>')).toEqual(['/review'])
  expect(text('<command-name><script>SECRET</script></command-name>')).toEqual([])
})

test('turns count what starts them: typed prompts and task or channel notes, and replies never merge across a turn', () => {
  const { rows, turns } = rowsOfTranscript(
    [
      assistant([{ type: 'text', text: 'Started the reviewers.' }], 1),
      user('<task-notification>SECRET reviewer done</task-notification>', 2),
      assistant([{ type: 'text', text: 'Reviewer A is back.' }], 3),
      user('<system-reminder>SECRET</system-reminder>', 4),
      assistant([{ type: 'text', text: 'Still waiting on B.' }], 5),
      user('<channel source="x">SECRET</channel>', 6),
      assistant([{ type: 'text', text: 'Both are back.' }], 7),
    ].join('\n'),
  )
  expect(rows.map(r => r.text)).toEqual(['Started the reviewers.', 'Reviewer A is back.\n\nStill waiting on B.', 'Both are back.'])
  expect(turns).toBe(3)
})

test('the conversation is capped: the last rows only, each row cut to the limit', () => {
  const lines: string[] = []
  for (let i = 0; i < 40; i += 1) {
    lines.push(user(`prompt ${i}`, i * 2))
    lines.push(assistant([{ type: 'text', text: i === 39 ? 'x'.repeat(9000) : `reply ${i}` }], i * 2 + 1))
  }
  const { rows } = rowsOfTranscript(lines.join('\n'))
  expect(rows.length).toBe(CONVERSATION_ROWS)
  expect(rows[0]?.text).toBe('prompt 25')
  expect(rows.at(-1)?.text.length).toBe(CONVERSATION_ROW_CHARS)
  expect(rows.at(-1)?.text.endsWith('…')).toBe(true)
  expect(rows.at(-1)?.cut).toBe(true)
  expect(rows.at(-2)?.cut).toBe(undefined)
  expect(rowsOfTranscript('not json\n{oops').rows).toEqual([])
})

test('a transcript is looked up only for a session in the snapshot, by a plain id', () => {
  const snapshot = buildSnapshot([
    session('local_a', { cliSessionId: '7b2a1902-f736-493b-9ee2-af26ebad5aac' }),
    session('local_b', { cliSessionId: '..\\..\\secrets' }),
    session('local_c', { cliSessionId: null }),
  ])
  expect(transcriptName(snapshot, 'local_a')).toBe('7b2a1902-f736-493b-9ee2-af26ebad5aac.jsonl')
  expect(transcriptName(snapshot, 'local_zzz')).toBeNull()
  expect(transcriptName(snapshot, '7b2a1902-f736-493b-9ee2-af26ebad5aac')).toBeNull()
  expect(transcriptName(snapshot, 'local_b')).toBeNull()
  expect(transcriptName(snapshot, 'local_c')).toBeNull()
  expect(transcriptName(null, 'local_a')).toBeNull()
})

test('a hidden session stays out of view until it is active again or needs you', () => {
  const quiet = session('local_q', { lastActivityAt: NOW - 60_000 })
  const hidden = { local_q: NOW - 60_000 }
  expect(isHiddenNow(quiet, hidden)).toBe(true)
  expect(isHiddenNow({ ...quiet, lastActivityAt: NOW - 1_000 }, hidden)).toBe(false)
  expect(isHiddenNow({ ...quiet, lifecycle: 'waiting-user', attention: 'question' }, hidden)).toBe(false)
  expect(isHiddenNow({ ...quiet, attention: 'review' }, hidden)).toBe(true)
  expect(isHiddenNow(quiet, {})).toBe(false)
  expect(isHiddenNow(session('__proto__'), {})).toBe(false)

  const snap = buildSnapshot([quiet, session('local_other')])
  const view = visibleOf(snap, DEFAULT_FILTERS, DEFAULT_SETTINGS, [], NOW, { pinned: ['local_q'], hidden })
  expect(view.sessions.map(s => s.key)).toEqual(['local_other'])
  expect(view.pinned.length).toBe(0)
  expect(view.nodes.some(n => n.id === 's:local_q')).toBe(false)
  expect(view.hiddenCount).toBe(1)
  const active = buildSnapshot([{ ...quiet, lastActivityAt: NOW - 1_000 }, session('local_other')])
  const back = visibleOf(active, DEFAULT_FILTERS, DEFAULT_SETTINGS, [], NOW, { hidden })
  expect(back.sessions.map(s => s.key).sort()).toEqual(['local_other', 'local_q'])
  expect(back.hiddenCount).toBe(0)
  expect(visibleOf(snap, DEFAULT_FILTERS, DEFAULT_SETTINGS, [], NOW).hiddenCount).toBe(0)
  const old = session('local_old', { lastActivityAt: NOW - 3 * 86_400_000 })
  const outside = buildSnapshot([quiet, old])
  const counted = visibleOf(outside, DEFAULT_FILTERS, DEFAULT_SETTINGS, [], NOW, { hidden: { ...hidden, local_old: old.lastActivityAt } })
  expect(counted.hiddenCount).toBe(1)
  expect(visibleOf(outside, DEFAULT_FILTERS, DEFAULT_SETTINGS, [], NOW, { pinned: ['local_old'], hidden: { local_old: old.lastActivityAt } }).hiddenCount).toBe(1)
})

test('the hidden preference is optional, cleaned and capped, keeping the most recently active', () => {
  expect(sanitizePrefs({}).hidden).toEqual({})
  expect(sanitizePrefs({ hidden: ['local_a'] }).hidden).toEqual({})
  const p = sanitizePrefs({ hidden: { local_a: 5, local_b: 'x', local_c: Number.NaN, local_d: -1, [`local_${'x'.repeat(700)}`]: 9 } })
  expect(p.hidden).toEqual({ local_a: 5 })
  const many = Object.fromEntries(Array.from({ length: MAX_HIDDEN + 20 }, (_, i) => [`local_${i}`, i]))
  const capped = sanitizePrefs({ hidden: many }).hidden ?? {}
  expect(Object.keys(capped).length).toBe(MAX_HIDDEN)
  expect(capped.local_0).toBeUndefined()
  expect(capped[`local_${MAX_HIDDEN + 19}`]).toBe(MAX_HIDDEN + 19)
})

test('the quick switcher ranks whole-text matches first, Needs you first within them, then the closest match, then the most recent', () => {
  const sessions = [
    session('local_sub', { title: 'Add unit tests helper', lastActivityAt: NOW - 1_000 }),
    session('local_inside', { title: 'OAuth token refresh', lastActivityAt: NOW - 2_000 }),
    session('local_word', { title: 'Fix auth bug', lastActivityAt: NOW - 50_000 }),
    session('local_start', { title: 'Authentication refactor', lastActivityAt: NOW - 90_000 }),
    session('local_project', { title: 'Docs', projectId: 'c:\\repo\\auth-service', lastActivityAt: NOW - 5_000 }),
    session('local_branch', { title: 'Cleanup', branch: 'feat/auth', lastActivityAt: NOW - 4_000 }),
    session('local_none', { title: 'Release notes', branch: 'main' }),
    session('local_wait', { title: 'Payments', lifecycle: 'waiting-user', attention: 'question', branch: 'fix/authz', lastActivityAt: NOW - 300_000 }),
    session('local_blocked', { title: 'Review Elastic logs', attention: 'blocked', lastActivityAt: NOW - 400_000 }),
  ]
  const name = (s: (typeof sessions)[number]) => s.projectId.split('\\').at(-1) ?? ''
  const attention = sessions.filter(s => s.attention === 'question' || s.attention === 'blocked')
  const rank = (query: string) => rankSessions(sessions, query, name, attention).map(s => s.key)
  expect(rank('auth')).toEqual([
    'local_wait',
    'local_start',
    'local_project',
    'local_word',
    'local_branch',
    'local_inside',
    'local_sub',
  ])
  expect(rank('fix bug')).toEqual(['local_word'])
  expect(rank('rel')).toEqual(['local_none', 'local_blocked'])
  expect(rank('').slice(0, 3)).toEqual(['local_wait', 'local_blocked', 'local_sub'])
})
