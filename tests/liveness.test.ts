import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import type { DesktopSession } from '../shared/aggregate/desktop.js'
import type { Paths } from '../src/paths'
import type { ToolRecord } from '../types'
import { normalizeSnapshot } from '../shared/filters.js'
import { hasProcessEnded, lifecycleOf, messageBlockOf, stuckOf } from '../shared/aggregate/infer.js'
import { budgetSnapshot } from '../shared/aggregate/budget.js'
import { defaultPrefs, readPrefsFile } from '../src/core/prefs'
import { createDesktopCache, scanDesktop } from '../shared/aggregate/desktop.js'
import { cleanRecord } from '../shared/aggregate/redact.js'
import { pub as publisher, publishFlush, publishPermission, publishStart, publishToolEnd, publishToolStart, publishTurnComplete, publishTurnStart, recordError, resetPublisher } from '../src/telemetry/publisher'
import { buildSnapshot, NOW, pub, session, synthetic } from './fixtures'

const STALE = 10 * 60_000

type Timer = { at: number; every: number | null; run: () => void; isCancelled: boolean }

function fakeEngine(files: Record<string, { text: string; mtimeMs: number }> = {}) {
  resetPublisher()
  let now = NOW
  const timers: Timer[] = []
  const writes: { path: string; text: string }[] = []
  const add = (ms: number, every: number | null, run: () => void) => {
    const timer: Timer = { at: now + ms, every, run, isCancelled: false }
    timers.push(timer)
    return { cancel: () => void (timer.isCancelled = true) }
  }
  const engine = {
    clock: { now: async () => now, every: (ms: number, run: () => void) => add(ms, ms, run), after: (ms: number, run: () => void) => add(ms, null, run) },
    session: { id: async () => 'cli-9', model: async () => null, version: async () => ({ version: 'test' }), repo: async () => null },
    agent: { list: async () => [] },
    fs: {
      read: async (path: string) => {
        const file = files[path]
        if (!file) throw new Error('ENOENT')
        return file.text
      },
      stat: async (path: string) => {
        const file = files[path]
        if (!file) throw new Error('ENOENT')
        return { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false }
      },
      exists: async (path: string) => path in files,
      write: async (path: string, text: string) => {
        writes.push({ path, text })
        files[path] = { text, mtimeMs: now }
      },
    },
  }
  const advance = async (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = timers.filter(t => !t.isCancelled && t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      now = due.at
      if (due.every === null) due.isCancelled = true
      else due.at += due.every
      due.run()
      for (let tick = 0; tick < 50; tick += 1) await Promise.resolve()
    }
    now = until
  }
  return { $: engine as unknown as EngineInterface, writes, files, advance, now: () => now }
}

const PATHS = { sep: '\\', sessionsDir: 'S' } as unknown as Paths
const records = (writes: { path: string; text: string }[]) => writes.filter(w => w.path === 'S\\cli-9.json').map(w => JSON.parse(w.text))

test('a killed session that was waiting for you leaves Needs you once its heartbeat is 90 s old (E-70)', () => {
  const turn = { isRunning: true, startedAt: NOW - 300_000, endedAt: null, lastReason: null }
  const waiting = { kind: 'question' as const, since: NOW - 200_000, tool: 'AskUserQuestion' }
  const live = lifecycleOf({ desktop: null, publisher: pub({ turn, waiting, heartbeatAt: NOW - 30_000 }), now: NOW, staleMs: STALE })
  expect(live.attention).toBe('question')
  const gone = lifecycleOf({ desktop: null, publisher: pub({ turn, waiting, heartbeatAt: NOW - 100_000 }), now: NOW, staleMs: STALE })
  expect(gone.attention).toBe(null)
  expect(gone.lifecycle).not.toBe('waiting-user')
  expect(gone.evidence.confidence).toBe('inferred')
})

test('an idle session that declares a slow heartbeat counts as ended once it stops beating; older records keep the old rule (E-70)', () => {
  const silent = pub({ idleBeatMs: 120_000, heartbeatAt: NOW - 5 * 60_000 })
  expect(hasProcessEnded(silent, null, NOW)).toBe(true)
  expect(messageBlockOf('cli-1', silent, null, NOW)).toBe('ended')
  expect(messageBlockOf('cli-1', pub({ idleBeatMs: 120_000, heartbeatAt: NOW - 60_000 }), null, NOW)).toBe(null)
  expect(messageBlockOf('cli-1', pub({ heartbeatAt: NOW - 60 * 60_000 }), null, NOW)).toBe(null)
})

test('the publisher beats every 2 minutes while idle and says so in its record (E-70)', async () => {
  const { $, writes, advance } = fakeEngine()
  await publishStart($, PATHS, 'C:\\repo', 'cli')
  expect(records(writes).at(-1)?.idleBeatMs).toBe(120_000)
  await advance(130_000)
  expect(records(writes).at(-1)?.heartbeatAt).toBeGreaterThanOrEqual(NOW + 120_000)
})

test('a sub-agent tool ending does not clear the main agent permission wait; the waited call ending does (E-76)', async () => {
  const { $ } = fakeEngine()
  await publishStart($, PATHS, 'C:\\repo', 'cli')
  await publishToolStart($, 'Bash', 'main-1', { command: 'npm test' }, undefined)
  await publishToolStart($, 'Read', 'sub-1', { file_path: 'C:\\repo\\a.ts' }, 'agent-1')
  await publishPermission($, 'Bash')
  await publishToolEnd($, 'Read', 'sub-1', false)
  expect(publisher.record?.waiting?.kind).toBe('permission')
  await publishToolEnd($, 'Bash', 'main-1', false)
  expect(publisher.record?.waiting).toBe(null)
})

test('a tool call in flight is marked pending and the mark clears when it ends (E-75)', async () => {
  const { $ } = fakeEngine()
  await publishStart($, PATHS, 'C:\\repo', 'cli')
  await publishToolStart($, 'Bash', 'main-1', { command: 'npm test' }, undefined)
  expect(publisher.record?.tools.at(-1)?.pending).toBe(true)
  await publishToolEnd($, 'Bash', 'main-1', true)
  expect(publisher.record?.tools.at(-1)?.pending).toBe(undefined)
  expect(publisher.record?.tools.at(-1)?.isError).toBe(true)
})

test('maybe stuck judges the last finished call, not the one still running (E-75)', () => {
  const call = (ago: number, patch: Partial<ToolRecord> = {}): ToolRecord => ({ at: NOW - ago, tool: 'Bash', category: 'test', target: 'npm test', isError: true, agentId: null, ...patch })
  const tools = [call(40_000), call(30_000), call(20_000), call(10_000, { isError: false, pending: true })]
  expect(stuckOf(tools, NOW, 'running', NOW - 60_000)?.kind).toBe('repeat')
})

test('a record without a turn object reads as idle instead of throwing (E-84)', () => {
  const broken = { ...pub(), turn: undefined } as unknown as Parameters<typeof cleanRecord>[0]
  const clean = cleanRecord(broken)
  expect(clean.turn).toEqual({ isRunning: false, startedAt: null, endedAt: null, lastReason: null })
  expect(() => lifecycleOf({ desktop: null, publisher: clean, now: NOW, staleMs: STALE })).not.toThrow()
})

test('a lifecycle or attention a newer leader invented reads as unknown (E-84)', () => {
  const raw = buildSnapshot([session('local_a', { lifecycle: 'napping' as never, attention: 'nap' as never })])
  const read = normalizeSnapshot(raw)
  expect(read.sessions[0]?.lifecycle).toBe('unknown')
  expect(read.sessions[0]?.attention).toBe(null)
})

test('a snapshot over its byte budget drops completed sub-agents first, then the oldest quiet sessions, and says how many (E-73)', () => {
  const full = synthetic(5, 60, 10)
  const size = JSON.stringify(full).length
  const trimmed = budgetSnapshot(full, Math.floor(size * 0.6))
  expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(Math.floor(size * 0.6))
  expect(trimmed.sources.budget?.droppedAgents ?? 0).toBeGreaterThan(0)
  expect(trimmed.agents.every(a => trimmed.sessions.some(s => s.key === a.sessionKey))).toBe(true)
  const tight = budgetSnapshot(full, Math.floor(size * 0.15))
  expect(tight.sources.budget?.droppedSessions ?? 0).toBeGreaterThan(0)
  expect(tight.sessions.filter(s => s.attention !== null).length).toBe(full.sessions.filter(s => s.attention !== null).length)
  expect(budgetSnapshot(full, size + 1)).toBe(full)
})

test('a prefs file that does not parse keeps the current prefs, and is backed up and rewritten once it has stayed broken (E-77)', async () => {
  const current = { ...defaultPrefs(), pinned: ['local_keep'] }
  const fresh = fakeEngine({ 'P\\prefs.json': { text: '{"schema":1,"pinned":["loc', mtimeMs: NOW - 1_000 } })
  const midWrite = await readPrefsFile(fresh.$, 'P\\prefs.json', current, NOW)
  expect(midWrite.prefs.pinned).toEqual(['local_keep'])
  expect(midWrite.isBroken).toBe(true)
  expect(fresh.writes.length).toBe(0)
  const stuck = fakeEngine({ 'P\\prefs.json': { text: '{"schema":1,"pinned":["loc', mtimeMs: NOW - 60_000 } })
  const repaired = await readPrefsFile(stuck.$, 'P\\prefs.json', current, NOW)
  expect(repaired.prefs.pinned).toEqual(['local_keep'])
  expect(stuck.writes.map(w => w.path)).toEqual(['P\\prefs.json.bad', 'P\\prefs.json'])
  expect(JSON.parse(stuck.files['P\\prefs.json']?.text ?? '{}').pinned).toEqual(['local_keep'])
  const missing = await readPrefsFile(fakeEngine().$, 'P\\prefs.json', current, NOW)
  expect(missing.prefs).toEqual(defaultPrefs())
  expect(missing.isBroken).toBe(false)
})

test('one failed desktop folder listing keeps the last good sessions (E-83)', async () => {
  let isListingBroken = false
  const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 10, mtimeMs: NOW, isLink: false })
  const fake = {
    fs: {
      exists: async () => true,
      list: async (path: string) => {
        if (isListingBroken) throw new Error('EBUSY')
        if (path === 'R') return [entry('acct', 'dir')]
        if (path === 'R\\acct') return [entry('org', 'dir')]
        return [entry('local_1.json', 'file')]
      },
      read: async () => JSON.stringify({ sessionId: 'local_1', cliSessionId: 'cli-1', lastActivityAt: NOW }),
    },
  } as unknown as EngineInterface
  const cache = createDesktopCache()
  const first = await scanDesktop(fake, cache, 'R', '\\', 50)
  expect(first.sessions.map((s: DesktopSession) => s.localId)).toEqual(['local_1'])
  isListingBroken = true
  const second = await scanDesktop(fake, cache, 'R', '\\', 50)
  expect(second.sessions.map((s: DesktopSession) => s.localId)).toEqual(['local_1'])
  expect(second.error).not.toBe(null)
})

test('tool churn is written at most every 5 s, while a turn starting or ending is written at once (E-111)', async () => {
  const { $, writes, advance } = fakeEngine()
  await publishStart($, PATHS, 'C:\repo', 'cli')
  const count = () => records(writes).length
  const atStart = count()
  await publishTurnStart($, undefined)
  expect(count()).toBe(atStart + 1)
  await publishToolStart($, 'Bash', 't1', { command: 'npm test' }, undefined)
  await advance(2_000)
  await publishToolEnd($, 'Bash', 't1', false)
  await advance(2_000)
  expect(count()).toBe(atStart + 1)
  await advance(1_500)
  expect(count()).toBe(atStart + 2)
  await publishTurnComplete($, undefined, 'answer')
  expect(count()).toBe(atStart + 3)
})

test('a sub-agent that ends its turn to wait on its own background work reads as waiting, not completed, once the engine says so', async () => {
  const { $, advance } = fakeEngine()
  let status = 'running'
  ;($ as unknown as { agent: { list: () => Promise<unknown[]> } }).agent.list = async () => [{ id: 'agent-1', type: 'general-purpose', description: 'greenlight', status }]
  await publishStart($, PATHS, 'C:/repo', 'cli')
  await publishTurnStart($, 'agent-1')
  await publishTurnComplete($, 'agent-1', 'answer')
  expect(publisher.record?.agents.find(a => a.id === 'agent-1')?.status).toBe('completed')
  status = 'waiting'
  await advance(31_000)
  const agent = publisher.record?.agents.find(a => a.id === 'agent-1')
  expect(agent?.status).toBe('waiting')
  expect(agent?.finishedAt).toBe(null)
  status = 'running'
  await advance(30_000)
  expect(publisher.record?.agents.find(a => a.id === 'agent-1')?.status).toBe('running')
})

test('a mod failure leaves a durable, text-free trace in the record that a later good write keeps (E-29)', async () => {
  const { $, writes } = fakeEngine()
  await publishStart($, PATHS, 'C:\repo', 'cli')
  const secret = new Error('ENOENT: no such file C:\Users\jak\secret-project\prompt.txt')
  await recordError($, 'tick', secret)
  await recordError($, 'hook', Object.assign(new Error('x'), { code: 'EPERM; rm -rf' }))
  await publishFlush($)
  const last = records(writes).at(-1)
  expect(last.errors).toEqual({ count: 2, lastAt: NOW, where: 'hook', kind: 'Error' })
  expect(JSON.stringify(last)).not.toContain('secret-project')
  await publishTurnStart($, undefined)
  await publishFlush($)
  expect(records(writes).at(-1).errors.count).toBe(2)
})

test('E-39: a test starts from a clean publisher: no error trace or pending tool left by an earlier test in this file', async () => {
  const { $, writes } = fakeEngine()
  expect(publisher.pendingTools.size).toBe(0)
  expect(publisher.errors).toBe(null)
  await publishStart($, PATHS, 'C:\repo', 'cli')
  await publishFlush($)
  expect(records(writes).at(-1).errors).toBe(undefined)
})
