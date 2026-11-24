import { expect, test } from 'claude-code/testing'

import type { EngineInterface } from 'claude-code'

import type { ToolRecord } from '../types'
import { DEFAULT_FILTERS, DEFAULT_SETTINGS } from '../shared/constants.js'
import { checkoutPeers, normalizeSnapshot, visibleOf } from '../shared/filters.js'
import { duration, limitsView, money, needsYouHotkey, plural, sessionFields, stateText } from '../shared/format.js'
import { identityOf } from '../shared/aggregate/aggregate.js'
import { createBranchCache, pruneBranchCache } from '../shared/aggregate/git.js'
import { createSubagentCache, transcriptActivity } from '../shared/aggregate/subagents.js'
import { agentLifecycle, hasProcessEnded, lifecycleOf, messageBlockOf, phaseFromTools, withRunningAgents } from '../shared/aggregate/infer.js'
import { sanitizePrefs } from '../src/core/prefs'
import { layoutGraph } from '../shared/layout.js'
import { isWrittenPastEdge, normalizeDesktop, withTranscriptActivity, type DesktopSession } from '../shared/aggregate/desktop.js'
import { lastEntryAt } from '../shared/conversation.js'
import { categorizeCommand, categorizeTool, cleanRecord, withoutCredentials } from '../shared/aggregate/redact.js'
import { agent, buildSnapshot, EV, NOW, pub, session, synthetic } from './fixtures'

const STALE = 10 * 60_000


function desk(patch: Partial<DesktopSession> = {}): DesktopSession {
  return {
    localId: 'local_1',
    cliSessionIds: ['cli-1'],
    title: 'Desk',
    cwd: 'C:\\repo',
    createdAt: NOW - 3_600_000,
    lastActivityAt: NOW - 30_000,
    lastTurnEdgeAt: NOW - 30_000,
    isMidTurn: false,
    midTurnSource: null,
    turnStartedAt: null,
    model: 'claude-opus-5-5',
    effort: null,
    permissionMode: 'default',
    completedTurns: 2,
    gitRoot: null,
    commonDir: null,
    prs: [],
    writtenBranches: [],
    summary: { category: null, detail: '', needsAction: '' },
    isInterruptedAwaitingPerson: false,
    isWaitingInput: false,
    ...patch,
  }
}

const tool = (category: ToolRecord['category'], ago: number, patch: Partial<ToolRecord> = {}): ToolRecord => ({
  at: NOW - ago,
  tool: 'X',
  category,
  target: 't',
  isError: false,
  agentId: null,
  ...patch,
})

test('a live permission wait outranks everything and is observed', () => {
  const r = lifecycleOf({ desktop: desk({ isMidTurn: true }), publisher: pub({ turn: { isRunning: true, startedAt: NOW, endedAt: null, lastReason: null }, waiting: { kind: 'permission', since: NOW - 5_000, tool: 'Bash' } }), now: NOW, staleMs: STALE })
  expect(r.lifecycle).toBe('waiting-permission')
  expect(r.attention).toBe('permission')
  expect(r.evidence.confidence).toBe('observed')
})

test('a running turn whose session stopped reporting goes stale, then disconnected, never completed', () => {
  const running = { isRunning: true, startedAt: NOW - 1_000_000, endedAt: null, lastReason: null }
  expect(lifecycleOf({ desktop: null, publisher: pub({ turn: running, heartbeatAt: NOW - 30_000 }), now: NOW, staleMs: STALE }).lifecycle).toBe('running')
  expect(lifecycleOf({ desktop: null, publisher: pub({ turn: running, heartbeatAt: NOW - 120_000 }), now: NOW, staleMs: STALE }).lifecycle).toBe('stale')
  expect(lifecycleOf({ desktop: null, publisher: pub({ turn: running, heartbeatAt: NOW - STALE - 1 }), now: NOW, staleMs: STALE }).lifecycle).toBe('disconnected')
})

test('a session that ended mid-turn is disconnected', () => {
  const r = lifecycleOf({ desktop: null, publisher: pub({ endedAt: NOW - 10_000, endReason: 'other', turn: { isRunning: true, startedAt: NOW - 60_000, endedAt: null, lastReason: null } }), now: NOW, staleMs: STALE })
  expect(r.lifecycle).toBe('disconnected')
})

test('desktop-only sessions: open turn is running while fresh and stale when silent', () => {
  expect(lifecycleOf({ desktop: desk({ isMidTurn: true, lastActivityAt: NOW - 60_000 }), publisher: null, now: NOW, staleMs: STALE }).lifecycle).toBe('running')
  expect(lifecycleOf({ desktop: desk({ isMidTurn: true, lastActivityAt: NOW - STALE - 1 }), publisher: null, now: NOW, staleMs: STALE }).lifecycle).toBe('stale')
})

test('a desktop session whose turn was started by a notification is running while its transcript keeps being written', () => {
  const started = desk({ lastTurnEdgeAt: NOW - 90_000, lastActivityAt: NOW - 90_000, summary: { category: 'review_ready', detail: '', needsAction: '' } })
  const open = withTranscriptActivity(started, { writtenAt: NOW - 3_000, lastEntryAt: NOW - 4_000, isRead: true }, NOW, STALE)
  expect(open.isMidTurn).toBe(true)
  expect(open.midTurnSource).toBe('transcript')
  expect(open.lastActivityAt).toBe(NOW - 3_000)
  expect(open.turnStartedAt).toBe(NOW - 90_000)
  const life = lifecycleOf({ desktop: open, publisher: null, now: NOW, staleMs: STALE })
  expect(life.lifecycle).toBe('running')
  expect(life.evidence.confidence).toBe('inferred')
  expect(life.evidence.detail).toContain('transcript')
})

test('a transcript that stopped at the turn edge, or long ago, leaves the session as it was', () => {
  const ended = desk({ lastTurnEdgeAt: NOW - 60_000, lastActivityAt: NOW - 60_000 })
  expect(withTranscriptActivity(ended, { writtenAt: NOW - 58_000, lastEntryAt: NOW - 58_000, isRead: true }, NOW, STALE)).toEqual(ended)
  const old = desk({ lastTurnEdgeAt: NOW - 30 * 3_600_000, lastActivityAt: NOW - 30 * 3_600_000 })
  expect(withTranscriptActivity(old, { writtenAt: NOW - 9 * 3_600_000, lastEntryAt: NOW - 9 * 3_600_000, isRead: true }, NOW, STALE)).toEqual(old)
  expect(withTranscriptActivity(ended, null, NOW, STALE)).toEqual(ended)
  const typed = desk({ isMidTurn: true, midTurnSource: 'user-frame', turnStartedAt: NOW - 20_000 })
  expect(withTranscriptActivity(typed, { writtenAt: NOW - 1_000, lastEntryAt: NOW - 1_000, isRead: true }, NOW, STALE)).toEqual(typed)
})

const EDGE = Date.parse('2026-11-10T15:40:39.985Z')
const EXITED_AT = EDGE + 14 * 60_000 + 36_000
const iso = (at: number) => new Date(at).toISOString()
const line = (entry: Record<string, unknown>) => JSON.stringify(entry)

function idleTranscript(): string {
  return [
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(EDGE - 6_312), sessionId: 'cli-1' }),
    line({ type: 'user', message: { role: 'user', content: 'x' }, uuid: 'u1', timestamp: iso(EDGE - 6_277), sessionId: 'cli-1' }),
    line({ type: 'file-history-snapshot', messageId: 'u1', snapshot: {}, isSnapshotUpdate: false }),
    line({ type: 'api-request', sessionId: 'cli-1', id: 'r1', timestamp: iso(EDGE - 2_914) }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, uuid: 'a1', timestamp: iso(EDGE - 2_096), sessionId: 'cli-1' }),
    line({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1, level: 'info', timestamp: iso(EDGE + 4_787), uuid: 's1', sessionId: 'cli-1' }),
    line({ type: 'last-prompt', lastPrompt: 'x', leafUuid: 'a1', sessionId: 'cli-1' }),
    line({ type: 'cost-state', sessionId: 'cli-1', totalCostUSD: 0.01 }),
    line({ type: 'mode', mode: 'plan', sessionId: 'cli-1' }),
    line({ type: 'cost-state', sessionId: 'cli-1', totalCostUSD: 0.01 }),
    '',
  ].join('\n')
}

test('regression (1.13.1): a desktop session whose idle process exited is asleep, not running, and not messageable', () => {
  const now = EDGE + 21 * 60_000
  const d = desk({ lastTurnEdgeAt: EDGE, lastActivityAt: EDGE + 4_802, turnStartedAt: EDGE - 6_277, permissionMode: 'plan' })
  const ended = pub({ startedAt: EDGE - 113_000, updatedAt: EXITED_AT, heartbeatAt: EXITED_AT, endedAt: EXITED_AT, endReason: 'other' })
  const text = idleTranscript()
  expect(lastEntryAt(text)).toBe(EDGE - 2_096)
  const writtenAt = EXITED_AT - 1_000
  expect(isWrittenPastEdge(d, writtenAt, now, STALE)).toBe(true)
  const read = withTranscriptActivity(d, { writtenAt, lastEntryAt: lastEntryAt(text), isRead: true }, now, STALE, ended.endedAt)
  expect(read).toEqual(d)
  expect(withTranscriptActivity(d, { writtenAt, lastEntryAt: lastEntryAt(text), isRead: true }, now, STALE, null)).toEqual(d)
  expect(withTranscriptActivity(d, { writtenAt, lastEntryAt: null, isRead: false }, now, STALE, ended.endedAt)).toEqual(d)
  expect(lifecycleOf({ desktop: read, publisher: ended, now, staleMs: STALE }).lifecycle).not.toBe('running')
  expect(hasProcessEnded(ended, read)).toBe(true)
  expect(messageBlockOf('cli-1', ended, read)).toBe('asleep')
})

test('regression (1.13.1): the same session started again (desktop resume) is messageable again', () => {
  const d = desk({ lastTurnEdgeAt: EDGE, lastActivityAt: EDGE + 4_802, turnStartedAt: EDGE - 6_277 })
  const restarted = pub({ startedAt: EDGE + 53 * 60_000, updatedAt: EDGE + 53 * 60_000, heartbeatAt: EDGE + 53 * 60_000, endedAt: null, endReason: null })
  expect(messageBlockOf('cli-1', restarted, d)).toBe(null)
  const ended = pub({ startedAt: EDGE - 113_000, endedAt: EXITED_AT, endReason: 'other' })
  expect(messageBlockOf('cli-1', ended, desk({ lastTurnEdgeAt: EXITED_AT + 60_000 }))).toBe(null)
  expect(messageBlockOf('cli-1', ended, desk({ lastTurnEdgeAt: EDGE, turnStartedAt: EXITED_AT + 60_000 }))).toBe(null)
  expect(messageBlockOf('cli-1', ended, desk({ lastTurnEdgeAt: EXITED_AT + 2_000 }))).toBe('asleep')
})

test('a genuinely running turn (a conversation entry after the edge) still reads as running, ended publisher or not', () => {
  const now = EDGE + 70_000
  const d = desk({ lastTurnEdgeAt: EDGE, lastActivityAt: EDGE, turnStartedAt: EDGE - 6_277 })
  const toolCall = line({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] }, timestamp: iso(EDGE + 60_000) })
  const text = `${idleTranscript()}${toolCall}\n${line({ type: 'cost-state', sessionId: 'cli-1' })}\n`
  expect(lastEntryAt(text)).toBe(EDGE + 60_000)
  const open = withTranscriptActivity(d, { writtenAt: EDGE + 61_000, lastEntryAt: lastEntryAt(text), isRead: true }, now, STALE)
  expect(open.isMidTurn).toBe(true)
  expect(lifecycleOf({ desktop: open, publisher: null, now, staleMs: STALE }).lifecycle).toBe('running')
  const endedBefore = pub({ startedAt: EDGE - 113_000, endedAt: EDGE - 30_000, endReason: 'other' })
  const resumed = withTranscriptActivity(d, { writtenAt: EDGE + 61_000, lastEntryAt: EDGE + 60_000, isRead: true }, now, STALE, endedBefore.endedAt)
  expect(resumed.isMidTurn).toBe(true)
  expect(lifecycleOf({ desktop: resumed, publisher: endedBefore, now, staleMs: STALE }).lifecycle).toBe('running')
  expect(messageBlockOf('cli-1', endedBefore, resumed)).toBe(null)
  const endedAfter = pub({ startedAt: EDGE - 113_000, endedAt: EDGE + 60_000, endReason: 'other' })
  expect(withTranscriptActivity(d, { writtenAt: EDGE + 61_000, lastEntryAt: EDGE + 60_000, isRead: true }, now, STALE, endedAfter.endedAt)).toEqual(d)
})

test('the last conversation entry skips meta, transcript-only, bad and untimed lines', () => {
  const meta = line({ type: 'user', isMeta: true, message: { content: 'x' }, timestamp: iso(EDGE + 9_000) })
  const shown = line({ type: 'user', isVisibleInTranscriptOnly: true, message: { content: 'x' }, timestamp: iso(EDGE + 8_000) })
  const untimed = line({ type: 'assistant', message: { content: 'x' } })
  const nested = line({ type: 'attachment', attachment: { type: 'user' }, note: '"type":"user"', timestamp: iso(EDGE + 7_000) })
  const real = line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] }, timestamp: iso(EDGE + 1_000) })
  expect(lastEntryAt([real, nested, untimed, '{"type":"user",', shown, meta].join('\n'))).toBe(EDGE + 1_000)
  expect(lastEntryAt('')).toBe(null)
  expect(lastEntryAt(`${line({ type: 'cost-state' })}\n`)).toBe(null)
})

test('who can be messaged: ended terminal sessions and sessions without an id cannot; sessions with no publisher keep the old rule', () => {
  const ended = pub({ endedAt: NOW - 60_000, endReason: 'other', entrypoint: 'cli' })
  expect(messageBlockOf('cli-1', ended, null)).toBe('ended')
  expect(messageBlockOf(null, null, desk())).toBe('no-id')
  expect(messageBlockOf('cli-1', null, desk())).toBe(null)
  expect(messageBlockOf('cli-1', null, null)).toBe(null)
  expect(messageBlockOf('cli-1', pub(), desk())).toBe(null)
})

test('a resumed session rewriting old subagent transcripts does not make them current: the last entry time counts, growth is activity', async () => {
  const LAST = NOW - 30 * 24 * 3_600_000
  const entry = (type: string, at: number) => JSON.stringify({ type, timestamp: new Date(at).toISOString() })
  const text = [entry('user', LAST - 60_000), entry('assistant', LAST), entry('system', NOW), ''].join('\n')
  const reads: string[] = []
  const fake = { fs: { read: async (path: string) => (reads.push(path), text) } } as unknown as EngineInterface
  const cache = createSubagentCache()
  const file = { path: 'agent-a.jsonl', mtimeMs: NOW - 1_000, size: text.length }
  expect(await transcriptActivity(fake, cache, file)).toBe(LAST)
  expect(await transcriptActivity(fake, cache, file)).toBe(LAST)
  expect(await transcriptActivity(fake, cache, { ...file, mtimeMs: NOW })).toBe(LAST)
  expect(await transcriptActivity(fake, cache, { ...file, mtimeMs: NOW + 5_000, size: text.length + 200 })).toBe(NOW + 5_000)
  expect(reads.length).toBe(1)
  expect(await transcriptActivity(fake, cache, { path: 'big.jsonl', mtimeMs: NOW, size: 5 * 1024 * 1024 })).toBe(NOW)
  expect(reads.length).toBe(1)
})

test('a session whose sub-agents still run reads as running, not idle or ready for review; a wait on you stays; finished ones get a green dot', () => {
  const idle = { lifecycle: 'idle' as const, evidence: EV, attention: 'review' as const, attentionText: 'Ready for review', since: NOW - 60_000 }
  const run = (id: string, startedAt: number) => agent('local_a', id, { lifecycle: 'running', startedAt, lastActivityAt: NOW - 5_000, evidence: { source: 'mod-events', confidence: 'observed', observedAt: NOW, detail: 'running' } })
  const done = agent('local_a', 'done', { lifecycle: 'completed', lastActivityAt: NOW - 1_000 })
  const waiting = withRunningAgents(idle, [run('r1', NOW - 600_000), run('r2', NOW - 300_000), done])
  expect([waiting.lifecycle, waiting.attention, waiting.attentionText, waiting.since, waiting.agentsRunning]).toEqual(['running', null, null, NOW - 600_000, 2])
  expect([waiting.evidence.source, waiting.evidence.confidence, waiting.evidence.detail]).toEqual(['mod-events', 'inferred', '2 sub-agents running'])
  expect(withRunningAgents(idle, [done]).lifecycle).toBe('idle')
  const asks = { ...idle, lifecycle: 'waiting-user' as const, attention: 'question' as const, attentionText: 'Pick one' }
  expect(withRunningAgents(asks, [run('r1', NOW)]).lifecycle).toBe('waiting-user')
  expect(withRunningAgents({ ...idle, lifecycle: 'failed' as const, attention: null }, [run('r1', NOW)]).lifecycle).toBe('failed')

  const snap = buildSnapshot([session('local_a', { lifecycle: 'running' })], [done, run('r1', NOW)])
  const view = visibleOf(snap, DEFAULT_FILTERS, DEFAULT_SETTINGS, [], NOW)
  expect(view.counts.agentsRunning).toBe(1)
})

test('subagents follow the time window: old finished ones drop out, running ones stay, Active now keeps only active ones', () => {
  const s = session('local_a', { lifecycle: 'running', lastActivityAt: NOW - 60_000 })
  const old = agent('local_a', 'old', { lifecycle: 'completed', startedAt: NOW - 30 * 3_600_000, lastActivityAt: NOW - 29 * 3_600_000, finishedAt: NOW - 29 * 3_600_000 })
  const recent = agent('local_a', 'recent', { lifecycle: 'completed', startedAt: NOW - 20 * 60_000, lastActivityAt: NOW - 10 * 60_000, finishedAt: NOW - 10 * 60_000 })
  const live = agent('local_a', 'live', { lifecycle: 'running', startedAt: NOW - 40 * 3_600_000, lastActivityAt: NOW - 40 * 3_600_000 })
  const snap = buildSnapshot([s], [old, recent, live])
  const shown = (time: string) =>
    visibleOf(snap, { ...DEFAULT_FILTERS, time } as typeof DEFAULT_FILTERS, DEFAULT_SETTINGS, [], NOW)
      .nodes.filter(n => n.kind === 'agent')
      .map(n => n.ref.split('/').at(-1))
      .sort()
  expect(shown('1h')).toEqual(['live', 'recent'])
  expect(shown('active')).toEqual(['live'])
  expect(shown('all')).toEqual(['live', 'old', 'recent'])
  const agentIds = (v: ReturnType<typeof visibleOf>) => v.nodes.filter(n => n.kind === 'agent').map(n => n.ref.split('/').at(-1)).sort()
  const strict = { ...DEFAULT_FILTERS, time: 'active' as const, showCompleted: false }
  expect(agentIds(visibleOf(snap, strict, DEFAULT_SETTINGS, [], NOW, { showAll: ['local_a'] }))).toEqual(['live', 'old', 'recent'])
  expect(agentIds(visibleOf(snap, strict, DEFAULT_SETTINGS, [], NOW, { expanded: ['local_a'] }))).toEqual(['live'])
  const capped = { ...DEFAULT_SETTINGS, maxSubagents: 0 }
  const pill = visibleOf(snap, { ...DEFAULT_FILTERS, time: '1h' }, capped, [], NOW)
  expect(pill.overflow['s:local_a']?.count).toBe(2)
  expect(agentIds(visibleOf(snap, { ...DEFAULT_FILTERS, time: '1h' }, capped, [], NOW, { expanded: ['local_a'] }))).toEqual(['live', 'recent'])
})

test("the app's summary drives idle states and is labelled inferred", () => {
  const done = lifecycleOf({ desktop: desk({ summary: { category: 'completed', detail: 'all done', needsAction: '' } }), publisher: null, now: NOW, staleMs: STALE })
  expect(done.lifecycle).toBe('completed')
  expect(done.evidence.confidence).toBe('inferred')
  const needs = lifecycleOf({ desktop: desk({ summary: { category: 'review_ready', detail: '', needsAction: 'approve the plan' } }), publisher: null, now: NOW, staleMs: STALE })
  expect(needs.attention).toBe('needs-you')
  expect(needs.attentionText).toBe('approve the plan')
})

test('a failed or interrupted last turn is reported as such', () => {
  const failed = lifecycleOf({ desktop: desk(), publisher: pub({ turn: { isRunning: false, startedAt: NOW - 60_000, endedAt: NOW - 20_000, lastReason: 'error' } }), now: NOW, staleMs: STALE })
  expect(failed.lifecycle).toBe('failed')
  expect(failed.attention).toBe('failed')
  const aborted = lifecycleOf({ desktop: desk(), publisher: pub({ turn: { isRunning: false, startedAt: NOW - 60_000, endedAt: NOW - 20_000, lastReason: 'aborted' } }), now: NOW, staleMs: STALE })
  expect(aborted.lifecycle).toBe('interrupted')
})

test('phase comes from the newest tool calls, with the debugging rule', () => {
  const opts = { isPlanMode: false, waiting: null, agentId: null }
  expect(phaseFromTools([tool('read', 9_000), tool('edit', 1_000)], NOW, opts).phase).toBe('implementing')
  expect(phaseFromTools([tool('test', 9_000, { isError: true }), tool('edit', 1_000)], NOW, opts).phase).toBe('debugging')
  expect(phaseFromTools([tool('edit', 9_000), tool('test', 1_000)], NOW, opts).phase).toBe('testing')
  expect(phaseFromTools([tool('merge', 1_000)], NOW, opts).phase).toBe('merging')
  expect(phaseFromTools([tool('search', 1_000), tool('shell', 500)], NOW, opts).phase).toBe('researching')
  expect(phaseFromTools([tool('edit', 20 * 60_000)], NOW, opts).phase).toBe('unknown')
  expect(phaseFromTools([], NOW, { ...opts, isPlanMode: true }).phase).toBe('planning')
  expect(phaseFromTools([], NOW, { ...opts, waiting: { kind: 'question', since: NOW, tool: 'AskUserQuestion' } }).phase).toBe('awaiting-response')
  expect(phaseFromTools([tool('edit', 1_000)], NOW, opts).evidence.confidence).toBe('inferred')
})

test('subagent phase only reads its own tool calls', () => {
  const tools = [tool('edit', 2_000), tool('read', 1_000, { agentId: 'a1' })]
  expect(phaseFromTools(tools, NOW, { isPlanMode: false, waiting: null, agentId: 'a1' }).phase).toBe('researching')
})

test('subagent lifecycle: live status first, metadata next, unknown otherwise', () => {
  expect(agentLifecycle('running', null, NOW - 1_000, NOW, STALE, 'mod-events').lifecycle).toBe('running')
  expect(agentLifecycle('running', null, NOW - STALE - 1, NOW, STALE, 'mod-events').lifecycle).toBe('stale')
  expect(agentLifecycle('killed', null, NOW, NOW, STALE, 'mod-events').lifecycle).toBe('interrupted')
  expect(agentLifecycle('waiting', true, NOW - STALE - 1, NOW, STALE, 'mod-events').lifecycle).toBe('running')
  expect(agentLifecycle('idle', null, NOW, NOW, STALE, 'mod-events').lifecycle).toBe('idle')
  expect(agentLifecycle(null, true, NOW, NOW, STALE, 'subagent-meta').lifecycle).toBe('completed')
  expect(agentLifecycle(null, false, NOW - 1_000, NOW, STALE, 'subagent-meta').evidence.confidence).toBe('inferred')
  expect(agentLifecycle(null, null, null, NOW, STALE, 'subagent-meta').lifecycle).toBe('unknown')
})

test('redaction keeps program names and file basenames, never arguments', () => {
  const t = categorizeCommand('cd C:\\repo && API_KEY=abc123 npm test -- --token=SECRET')
  expect(t.category).toBe('test')
  expect(JSON.stringify(t)).not.toContain('SECRET')
  expect(JSON.stringify(t)).not.toContain('abc123')
  const commit = categorizeCommand('git commit -m "password=hunter2"')
  expect(commit).toEqual({ category: 'git-write', target: 'git commit' })
  expect(categorizeCommand('git rebase main').category).toBe('merge')
  expect(categorizeCommand('gh pr diff 12').category).toBe('review')
  expect(categorizeTool('Read', { file_path: 'C:\\Users\\me\\secrets\\config.ts' }).target).toBe('config.ts')
  expect(categorizeTool('WebFetch', { url: 'https://example.com/path?token=x' }).target).toBe('example.com')
  expect(categorizeTool('mcp__github__create_pr', {}).target).toBe('github/create_pr')
})

test('redaction drops assignments, variables and quoted arguments from the program name', () => {
  const cases: [string, string, string][] = [
    ["$env:GH_TOKEN='ghp_AbCdEfGhIjKl'; gh pr list", 'gh pr', 'ghp_'],
    ['token=s3cr3t ./deploy.sh', 'deploy.sh', 's3cr3t'],
    ["$pw = 'Hunter2!'; .\\run.ps1", 'run', 'Hunter2'],
    ['claude "summarise the secret plan"', 'claude', 'secret'],
    ['& "C:\\Tools\\x.exe" --key=abc', 'shell', 'abc'],
    ['& "C:\\Users\\me\\Acme Merger Docs\\run.ps1"', 'shell', 'Acme'],
    ["'ghp_AbCdEfGhIjKlMnOp1234' | gh auth login --with-token", 'shell', 'ghp_'],
    ['ghp_AbCdEfGhIjKlMnOp1234567 --flag', 'shell', 'ghp_'],
    ['git 0123456789abcdef0123', 'git', '0123456789'],
    ['npm run "build; rm -rf x"', 'npm run', 'rm'],
    ['export API_KEY=zzz && npm run build', 'npm run', 'zzz'],
    ['claude explain the secret auth bug', 'claude', 'explain'],
  ]
  for (const [command, target, secret] of cases) {
    const result = categorizeCommand(command)
    expect(result.target).toBe(target)
    expect(JSON.stringify(result)).not.toContain(secret)
  }
  expect(categorizeTool('Grep', { pattern: 'sk-ant-api03-secret' }).target).toBe('code')
  expect(categorizeTool('Glob', { pattern: '**/*.env', path: 'C:\\repo\\config' }).target).toBe('config')
})

test('a remote URL loses any credentials before it is published', () => {
  expect(withoutCredentials('https://x-access-token:ghp_abc@github.com/o/r.git')).toBe('https://github.com/o/r.git')
  expect(withoutCredentials('https://github.com/o/r.git')).toBe('https://github.com/o/r.git')
  expect(withoutCredentials('git@github.com:o/r.git')).toBe('git@github.com:o/r.git')
})

test('desktop records: archived dropped, only https PR links, branch names kept', () => {
  expect(normalizeDesktop({ sessionId: 'local_1', isArchived: true }, NOW, new Set())).toBeNull()
  const d = normalizeDesktop(
    {
      sessionId: 'local_2',
      cliSessionId: 'cli-2',
      title: 'T',
      prs: [
        { prNumber: 3, url: 'https://github.com/o/r/pull/3', repo: 'o/r', state: 'OPEN' },
        { prNumber: 4, url: 'javascript:alert(1)', repo: 'o/r' },
      ],
      writtenBranches: ['C:\\repo\u0000feat/x'],
      latestUserFrameAt: NOW,
      lastTurnEdgeAt: NOW - 1,
      gitAnchors: [{ gitRoot: 'C:\\repo', commonDir: 'C:\\repo\\.git' }],
    },
    NOW,
    new Set(['local_2']),
  )
  expect(d?.prs.length).toBe(1)
  expect(d?.writtenBranches).toEqual(['feat/x'])
  expect(d?.isMidTurn).toBe(true)
  expect(d?.isWaitingInput).toBe(true)
  expect(d?.commonDir).toBe('C:\\repo\\.git')
})

test('layout is deterministic and a status change moves nothing', () => {
  const a = synthetic(3, 12, 2)
  const b = synthetic(3, 12, 2)
  expect(JSON.stringify(a.graph)).toBe(JSON.stringify(b.graph))
  const changed = buildSnapshot(
    a.sessions.map(s => ({ ...s, lifecycle: 'failed' as const, attention: 'failed' as const })),
    a.agents.map(x => ({ ...x, lifecycle: 'completed' as const })),
  )
  expect(changed.graph.nodes.map(n => [n.id, n.x, n.y])).toEqual(a.graph.nodes.map(n => [n.id, n.x, n.y]))
})

test('a new session in an existing project leaves the older sessions where they were', () => {
  const base = [session('local_a'), session('local_b', { createdAt: NOW - 1_000_000 }), session('local_c', { createdAt: NOW - 900_000 })]
  const before = buildSnapshot(base)
  const after = buildSnapshot([...base, session('local_d', { createdAt: NOW })])
  for (const key of ['local_a', 'local_b', 'local_c']) {
    const n1 = before.graph.nodes.find(n => n.id === `s:${key}`)
    const n2 = after.graph.nodes.find(n => n.id === `s:${key}`)
    expect([n2?.x, n2?.y]).toEqual([n1?.x, n1?.y])
  }
})

test('a dragged session keeps its offset and its subagents move with it', () => {
  const sessions = [session('local_a')]
  const agents = [agent('local_a', 'x1')]
  const plain = buildSnapshot(sessions, agents)
  const project = plain.graph.nodes.find(n => n.kind === 'project')
  const moved = buildSnapshot(sessions, agents, { 's:local_a': { dx: 300, dy: -200 } })
  const s = moved.graph.nodes.find(n => n.id === 's:local_a')
  expect([s?.x, s?.y]).toEqual([(project?.x ?? 0) + 300, (project?.y ?? 0) - 200])
  const a0 = plain.graph.nodes.find(n => n.kind === 'agent')
  const s0 = plain.graph.nodes.find(n => n.id === 's:local_a')
  const a1 = moved.graph.nodes.find(n => n.kind === 'agent')
  const r = (n: number) => Math.round(n * 1000) / 1000
  expect([r((a1?.x ?? 0) - (s?.x ?? 0)), r((a1?.y ?? 0) - (s?.y ?? 0))]).toEqual([r((a0?.x ?? 0) - (s0?.x ?? 0)), r((a0?.y ?? 0) - (s0?.y ?? 0))])
})

test('filters: active now, completed, needs-you only, search and project', () => {
  const snap = buildSnapshot([
    session('local_run', { lifecycle: 'running' }),
    session('local_wait', { lifecycle: 'waiting-user', attention: 'question' }),
    session('local_done', { lifecycle: 'completed', title: 'Billing API review' }),
    session('local_old', { lastActivityAt: NOW - 3 * 24 * 3_600_000 }),
    session('local_other', { projectId: 'c:\\repo\\other', worktreeId: null }),
  ])
  const keys = (f: Partial<typeof DEFAULT_FILTERS>) => visibleOf(snap, { ...DEFAULT_FILTERS, ...f }, DEFAULT_SETTINGS, [], NOW).sessions.map(s => s.key).sort()
  expect(keys({ time: 'active' })).toEqual(['local_run', 'local_wait'])
  expect(keys({ time: '24h' })).not.toContain('local_old')
  expect(keys({ time: 'all' })).toContain('local_old')
  expect(keys({ showCompleted: false })).not.toContain('local_done')
  expect(keys({ attentionOnly: true })).toEqual(['local_wait'])
  expect(keys({ search: 'billing' })).toEqual(['local_done'])
  expect(keys({ project: 'c:\\repo\\other' })).toEqual(['local_other'])
})

test('subagents past the cap become a "+N" pill on their session, which expanding lifts; a collapsed project hides its sessions', () => {
  const agents = Array.from({ length: 12 }, (_, i) => agent('local_a', `x${i}`))
  const snap = buildSnapshot([session('local_a'), session('local_b')], agents)
  const settings = { ...DEFAULT_SETTINGS, maxSubagents: 4 }
  const view = visibleOf(snap, DEFAULT_FILTERS, settings, [], NOW)
  expect(view.nodes.filter(n => n.kind === 'agent').length).toBe(4)
  expect(view.nodes.every(n => KINDS_DRAWN.has(n.kind))).toBe(true)
  expect(view.overflow['s:local_a']).toEqual({ count: 8, reason: 'cap', noun: 'subagent' })
  const expanded = visibleOf(snap, DEFAULT_FILTERS, settings, [], NOW, { expanded: ['local_a'] })
  expect(expanded.nodes.filter(n => n.kind === 'agent').length).toBe(12)
  expect(expanded.overflow['s:local_a']).toBeUndefined()
  const collapsed = visibleOf(snap, DEFAULT_FILTERS, DEFAULT_SETTINGS, ['p:c:\\repo\\app'], NOW)
  expect(collapsed.nodes.filter(n => n.kind === 'session').length).toBe(0)
  expect(collapsed.overflow['p:c:\\repo\\app']).toEqual({ count: 2, reason: 'collapsed', noun: 'session' })
})

const KINDS_DRAWN = new Set(['project', 'worktree', 'session', 'agent', 'pr'])

test('preferences are clamped and unknown values fall back to defaults', () => {
  const p = sanitizePrefs({ settings: { refreshSec: 1, animation: 'disco', maxSessions: 99999 }, filters: { time: 'forever' }, positions: { a: { dx: 1, dy: 2 }, b: { dx: 'x' } } })
  expect(p.settings.refreshSec).toBe(5)
  expect(p.settings.animation).toBe('off')
  expect(p.settings.maxSessions).toBe(300)
  expect(p.filters.time).toBe('24h')
  expect(Object.keys(p.positions)).toEqual(['a'])
})

test('session names saved in Orbit are one trimmed line of at most 120 characters; session colours are swatch names, blue included', () => {
  const p = sanitizePrefs({ titles: { a: '  Login' + String.fromCharCode(10) + '  fix ', b: '   ', c: 5, d: 'x'.repeat(200), __proto__: 'y' }, tints: { a: 'pink', b: 'blue', c: 'orange', d: 7 } })
  expect(p.titles).toEqual({ a: 'Login fix', d: 'x'.repeat(120) })
  expect(p.tints).toEqual({ a: 'pink', b: 'blue' })
})

test('project colours are swatch names other than blue, the default', () => {
  const p = sanitizePrefs({ projectTints: { a: 'red', b: 'blue', c: 'orange', d: 7 } })
  expect(p.projectTints).toEqual({ a: 'red' })
})

test('layout of an empty input is empty', () => {
  expect(layoutGraph({ projects: [], worktrees: [], sessions: [], agents: [] }, {})).toEqual({ nodes: [], edges: [] })
})

test('a session waiting on you is always counted, whatever the time window or project filter', () => {
  const snap = buildSnapshot([
    session('local_wait', { lifecycle: 'waiting-permission', attention: 'permission', lastActivityAt: NOW - 3 * 24 * 3_600_000 }),
    session('local_blocked_old', { attention: 'blocked', lastActivityAt: NOW - 3 * 24 * 3_600_000 }),
    session('local_other', { projectId: 'c:\\repo\\other', worktreeId: null }),
  ])
  const view = visibleOf(snap, { ...DEFAULT_FILTERS, project: 'c:\\repo\\other' }, DEFAULT_SETTINGS, [], NOW)
  expect(view.attention.map(s => s.key)).toEqual(['local_wait'])
  expect(view.counts.attention).toBe(1)
  expect(view.sessions.map(s => s.key)).toEqual(['local_other'])
})

test('each lifecycle says since when it has held, from the best source', () => {
  const running = lifecycleOf({ desktop: null, publisher: pub({ turn: { isRunning: true, startedAt: NOW - 240_000, endedAt: null, lastReason: null } }), now: NOW, staleMs: STALE })
  expect([running.lifecycle, running.since]).toEqual(['running', NOW - 240_000])
  const waiting = lifecycleOf({ desktop: null, publisher: pub({ waiting: { kind: 'permission', since: NOW - 90_000, tool: 'Bash' } }), now: NOW, staleMs: STALE })
  expect(waiting.since).toBe(NOW - 90_000)
  const deskRunning = lifecycleOf({ desktop: desk({ isMidTurn: true, turnStartedAt: NOW - 50_000, lastActivityAt: NOW - 5_000 }), publisher: null, now: NOW, staleMs: STALE })
  expect([deskRunning.lifecycle, deskRunning.since]).toEqual(['running', NOW - 50_000])
  const idle = lifecycleOf({ desktop: desk({ lastTurnEdgeAt: NOW - 600_000 }), publisher: null, now: NOW, staleMs: STALE })
  expect([idle.lifecycle, idle.since]).toEqual(['idle', NOW - 600_000])
})

test('time in state shows only where it matters, and needs-you says what is needed', () => {
  expect(stateText(session('local_r', { lifecycle: 'running', stateSince: NOW - 12 * 60_000 }), NOW)).toBe('Running 12m')
  expect(stateText(session('local_p', { lifecycle: 'waiting-permission', attention: 'permission', stateSince: NOW - 20_000 }), NOW)).toBe('Needs permission <1m')
  expect(stateText(session('local_w', { lifecycle: 'idle', attention: 'needs-you', stateSince: NOW - 3 * 3_600_000 }), NOW)).toBe('Needs you 3h')
  expect(stateText(session('local_i', { lifecycle: 'idle', stateSince: NOW - 3 * 3_600_000 }), NOW)).toBe('Idle')
  expect([duration(40_000), duration(90 * 60_000), duration(3 * 86_400_000)]).toEqual(['<1m', '2h', '3d'])
  expect([money(1.234), money(42.6), money(0.004)]).toEqual(['$1.23', '$43', '<$0.01'])
})

test('rate limits drop windows that have reset and say when a reading is old', () => {
  const usage = (observedAt: number, resetsAt: string | null) => ({
    rateLimits: [
      { kind: 'five_hour', percentUsed: 82.5, resetsAt },
      { kind: 'seven_day', percentUsed: 18, resetsAt: null },
    ],
    evidence: { ...EV, source: 'mod-events' as const, observedAt },
  })
  const fresh = limitsView(usage(NOW - 60_000, new Date(NOW + 3_600_000).toISOString()), NOW)
  expect(fresh?.parts.map(p => p.text)).toEqual(['5h 83%', '7d 18%'])
  expect([fresh?.max, fresh?.parts[0]?.isHigh, fresh?.parts[1]?.isHigh]).toEqual([82.5, true, false])
  const reset = limitsView(usage(NOW - 60_000, new Date(NOW - 1_000).toISOString()), NOW)
  expect(reset?.parts.map(p => p.text)).toEqual(['7d 18%'])
  expect(limitsView(usage(NOW - 40 * 60_000, null), NOW)?.asOf).not.toBeNull()
  expect(limitsView(null, NOW)).toBeNull()
})

test('a snapshot from an older leader reads its missing fields as unknown', () => {
  const snap = buildSnapshot([session('local_a')])
  const old = { ...snap, usage: undefined, sessions: snap.sessions.map(({ stateSince: _a, finishedAt: _b, cost: _c, stuck: _d, ...rest }) => rest) } as unknown as typeof snap
  const read = normalizeSnapshot(old)
  expect(read.usage).toBeNull()
  expect([read.sessions[0]?.stateSince, read.sessions[0]?.finishedAt, read.sessions[0]?.cost, read.sessions[0]?.stuck]).toEqual([null, null, null, null])
  const odd = normalizeSnapshot({ ...snap, sessions: [session('local_b', { stuck: { kind: 'loop', text: 'x', since: 1 } as never })] })
  expect(odd.sessions[0]?.stuck).toBeNull()
  const kept = normalizeSnapshot({ ...snap, sessions: [session('local_c', { stuck: { kind: 'errors', text: '4 of the last 6 calls failed', since: NOW } })] })
  expect(kept.sessions[0]?.stuck).toEqual({ kind: 'errors', text: '4 of the last 6 calls failed', since: NOW })
})

test('active sessions in the same checkout are flagged to each other, and only those', () => {
  const sessions = [
    session('local_a', { lifecycle: 'running', worktreeId: 'c:\\repo\\app' }),
    session('local_b', { lifecycle: 'waiting-user', attention: 'question', worktreeId: 'c:\\repo\\app' }),
    session('local_c', { lifecycle: 'idle', worktreeId: 'c:\\repo\\app' }),
    session('local_d', { lifecycle: 'running', worktreeId: 'c:\\repo\\app\\.claude\\worktrees\\x' }),
  ]
  const peers = checkoutPeers(sessions)
  expect(Object.keys(peers).sort()).toEqual(['local_a', 'local_b'])
  expect(peers.local_a?.map(s => s.key)).toEqual(['local_b'])
  const fields = sessionFields(sessions[0] as (typeof sessions)[number], undefined, undefined, NOW, STALE, peers.local_a)
  expect(fields.find(([label]) => label === 'Same checkout')?.[1]).toContain('may edit the same files')
})

test('the branch cache forgets checkouts not asked about for ten minutes', () => {
  const cache = createBranchCache()
  cache.set('c:\\old', { at: NOW - 11 * 60_000, branch: 'main' })
  cache.set('c:\\new', { at: NOW - 60_000, branch: 'dev' })
  pruneBranchCache(cache, NOW)
  expect([...cache.keys()]).toEqual(['c:\\new'])
})

test('a terminal session in a .claude worktree is its own checkout of the main repository', () => {
  const inWorktree = identityOf(null, pub({ cwd: 'C:\\repo\\app\\.claude\\worktrees\\feat\\src', repoRoot: 'C:\\repo\\app\\.claude\\worktrees\\feat' }))
  expect([inWorktree.projectId, inWorktree.worktree]).toEqual(['c:\\repo\\app', 'C:\\repo\\app\\.claude\\worktrees\\feat'])
  const inSubfolder = identityOf(null, pub({ cwd: 'C:\\repo\\app\\src', repoRoot: 'C:\\repo\\app' }))
  expect(inSubfolder.worktree).toBe('C:\\repo\\app')
  const elsewhere = identityOf(null, pub({ cwd: 'D:\\scratch', repoRoot: 'C:\\repo\\app' }))
  expect(elsewhere.worktree).toBe('D:\\scratch')
})

test('records are re-redacted on read: credentials in a remote never pass, long descriptions are cut, current targets stay (X-1: one rule set)', () => {
  const current: ToolRecord[] = [
    { at: NOW, tool: 'Bash', category: 'test', target: 'npm test', isError: false, agentId: null },
    { at: NOW, tool: 'Agent', category: 'review', target: 'C4 review: spec leg', isError: false, agentId: null },
    { at: NOW, tool: 'Grep', category: 'search', target: 'src', isError: false, agentId: null },
    { at: NOW, tool: 'Read', category: 'read', target: "it's.md", isError: false, agentId: null },
    { at: NOW, tool: 'Agent', category: 'agent', target: "Find the user's config", isError: false, agentId: null },
  ]
  expect(cleanRecord(pub({ tools: current })).tools.map(t => t.target)).toEqual(['npm test', 'C4 review: spec leg', 'src', "it's.md", "Find the user's config"])
  const leaky = pub({
    tools: [
      { at: NOW, tool: 'PowerShell', category: 'shell', target: '$env:GH_TOKEN="ghp_x', isError: false, agentId: null },
      { at: NOW, tool: 'Bash', category: 'shell', target: 'token=abc', isError: false, agentId: null },
      { at: NOW, tool: 'Grep', category: 'search', target: 'password', isError: false, agentId: null },
      { at: NOW, tool: 'Agent', category: 'agent', target: 'use key="sk-1"', isError: false, agentId: null },
    ],
    timeline: [{ at: NOW, kind: 'tool', text: 'Running $env:GH_TOKEN="ghp_x failed' }],
    agents: [{ id: 'a', parentId: null, type: 't', description: 'x'.repeat(500), name: null, model: null, status: 'running', startedAt: null, lastActivityAt: null, finishedAt: null }],
  })
  const clean = cleanRecord({ ...leaky, repoRemote: 'https://jak:ghp_y@github.com/o/r.git' })
  expect(clean.repoRemote).toBe('https://github.com/o/r.git')
  expect(clean.tools.slice(0, 2).map(t => t.target)).toEqual(['shell', 'shell'])
  expect(clean.agents[0]?.description.length).toBe(120)
})

test('Needs you keys stop at 9 and counts read naturally', () => {
  expect([needsYouHotkey(0), needsYouHotkey(8), needsYouHotkey(9)]).toEqual(['1', '9', null])
  expect([plural(1, 'session'), plural(2, 'session'), plural(1, 'other active session')]).toEqual(['1 session', '2 sessions', '1 other active session'])
})


test('a desktop waiting marker outranks the mod saying the turn runs: a permission prompt with no hook is Needs you (E-06)', () => {
  const running = pub({ turn: { isRunning: true, startedAt: NOW - 60_000, endedAt: null, lastReason: null }, heartbeatAt: NOW - 1_000 })
  const r = lifecycleOf({ desktop: desk({ isMidTurn: true, isWaitingInput: true }), publisher: running, now: NOW, staleMs: STALE })
  expect(r.lifecycle).toBe('waiting-user')
  expect(r.attention).toBe('question')
  expect(r.evidence.source).toBe('desktop-metadata')
  expect(lifecycleOf({ desktop: desk({ isMidTurn: true }), publisher: running, now: NOW, staleMs: STALE }).lifecycle).toBe('running')
})
