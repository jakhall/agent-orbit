import { expect, test } from 'claude-code/testing'

import type { PrStatus, ToolRecord } from '../types'
import { CHANGE_FILES, CHANGE_UNTRACKED, changeRows, editedPathsOf, outsideGroups, parseNumstatZ } from '../shared/changes.js'
import { ghUnavailable, isPrDue, isPrUrl, latestChecks, prSummary, prViewArgs } from '../shared/prs.js'
import { prNumber } from '../shared/render.js'
import { STUCK, stuckOf } from '../shared/aggregate/infer.js'
import { NOW, session } from './fixtures'

test('numstat -z: counts, binary files as null, and renames split over three fields', () => {
  const text = ['2\t1\ta.txt', '-\t-\tbin.dat', '0\t0\t', 'old name.txt', 'new name.txt', '5\t0\tdir/ünï tab.txt', ''].join('\0')
  expect(parseNumstatZ(text)).toEqual([
    { path: 'a.txt', oldPath: null, added: 2, removed: 1 },
    { path: 'bin.dat', oldPath: null, added: null, removed: null },
    { path: 'new name.txt', oldPath: 'old name.txt', added: 0, removed: 0 },
    { path: 'dir/ünï tab.txt', oldPath: null, added: 5, removed: 0 },
  ])
})

test('transcript edits: Edit, Write, MultiEdit and NotebookEdit paths, sidechains too; reads, results and bad lines give none', () => {
  const line = (content: unknown, extra = {}) => JSON.stringify({ type: 'assistant', message: { content }, ...extra })
  const use = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: name, name, input })
  expect(editedPathsOf(line([use('Edit', { file_path: 'C:\\r\\a.ts' }), use('Write', { file_path: 'C:\\r\\b.ts' })]))).toEqual(['C:\\r\\a.ts', 'C:\\r\\b.ts'])
  expect(editedPathsOf(line([use('MultiEdit', { file_path: 'C:\\r\\c.ts', edits: [] })], { isSidechain: true }))).toEqual(['C:\\r\\c.ts'])
  expect(editedPathsOf(line([use('NotebookEdit', { notebook_path: 'C:\\r\\n.ipynb' })]))).toEqual(['C:\\r\\n.ipynb'])
  expect(editedPathsOf(line([use('Read', { file_path: 'C:\\r\\a.ts' })]))).toEqual([])
  expect(editedPathsOf(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '"tool_use" Edit file_path' }] } }))).toEqual([])
  expect(editedPathsOf('{"type":"assistant","message":{"content":[{"type":"tool_use"')).toEqual([])
  expect(editedPathsOf('plain text')).toEqual([])
})

const places = { home: 'C:\\Users\\Me', temp: 'C:\\Users\\Me\\AppData\\Local\\Temp', checkouts: ['C:\\repos\\Nodes', 'C:\\repos'] }

test('changes merge: session edits first, case-insensitive, conflicts as U, an edited new folder, outside edits grouped, untracked capped', () => {
  const status = [{ code: ' M', path: 'src/A.ts', oldPath: null }, { code: 'A ', path: 'b.ts', oldPath: null }, { code: ' D', path: 'gone.ts', oldPath: null }, { code: 'AA', path: 'both.ts', oldPath: null }, { code: '??', path: 'new.ts', oldPath: null }, { code: '??', path: 'notes/', oldPath: null }, { code: '??', path: 'tmp/', oldPath: null }]
  const numstat = parseNumstatZ(['3\t1\tsrc/A.ts', '1\t0\tb.ts', '0\t4\tgone.ts', '-\t-\tlogo.png', ''].join('\0'))
  const edits = ['c:\\repo\\app\\SRC\\a.ts', 'C:/Repo/App/new.ts', 'C:\\Repo\\App\\notes\\idea.md', 'C:\\other\\x.ts', 'C:\\Repo\\Apple\\y.ts']
  const view = changeRows({ root: 'C:\\Repo\\App\\', status, numstat, edits, places })
  expect(view.files.map(f => [f.path, f.status, f.isEdited, f.isBinary])).toEqual([
    ['src/A.ts', 'M', true, false],
    ['b.ts', 'A', false, false],
    ['both.ts', 'U', false, false],
    ['gone.ts', 'D', false, false],
    ['logo.png', 'M', false, true],
  ])
  expect(view.totals).toEqual({ files: 5, added: 4, removed: 5 })
  expect(view.untracked).toEqual({ count: 3, names: [{ path: 'new.ts', isEdited: true }, { path: 'notes/', isEdited: true }, { path: 'tmp/', isEdited: false }] })
  expect(view.outside).toEqual({ count: 2, scratch: 0, groups: [{ label: 'Apple', root: 'C:\\Repo\\Apple', count: 1, paths: ['y.ts'] }, { label: 'other', root: 'C:\\other', count: 1, paths: ['x.ts'] }], moreGroups: 0 })
  const many = changeRows({ root: 'C:\\r', status: Array.from({ length: 30 }, (_, i) => ({ code: '??', path: `u${i}.ts`, oldPath: null })), numstat: Array.from({ length: CHANGE_FILES + 5 }, (_, i) => ({ path: `f${i}.ts`, oldPath: null, added: 1, removed: 0 })), edits: [] })
  expect([many.files.length, many.moreFiles, many.untracked.count, many.untracked.names.length]).toEqual([CHANGE_FILES, 5, 30, CHANGE_UNTRACKED])
})

test('outside edits: temp, scratchpad, session memory and plans are only counted; the rest grouped by known checkout, else folder', () => {
  const view = outsideGroups(
    [
      'C:\\Users\\Me\\AppData\\Local\\Temp\\claude\\x\\scratchpad\\a.py',
      'C:\\Users\\Me\\.claude\\projects\\C--x\\memory\\m.md',
      'C:\\Users\\Me\\.claude\\plans\\p.md',
      'C:\\repos\\Nodes\\companion\\app.js',
      'C:/repos/Nodes/shared/x.js',
      'C:\\other\\loose.txt',
      'C:\\Users\\Me\\.claude\\mods\\real.ts',
    ],
    places,
  )
  expect([view.count, view.scratch]).toEqual([7, 3])
  expect(view.groups.map(g => [g.label, g.count, g.paths])).toEqual([
    ['Nodes', 2, ['companion\\app.js', 'shared\\x.js']],
    ['mods', 1, ['real.ts']],
    ['other', 1, ['loose.txt']],
  ])
})

test('only plain GitHub pull request links reach gh, as an argv array; rows and nodes name them by repo and number', () => {
  expect(isPrUrl('https://github.com/acme/app.js/pull/12')).toBe(true)
  for (const bad of ['http://github.com/a/b/pull/1', 'https://github.com/a/b/pull/1?x=1', 'https://github.com/a/b/pull/1#c', 'https://user@github.com/a/b/pull/1', 'https://github.com.evil/a/b/pull/1', 'https://github.com/a/b/pull/1/files', 'https://github.com/a/b/pull/x', 'https://github.com/a b/c/pull/1', '--help', 42, null]) {
    expect(isPrUrl(bad)).toBe(false)
  }
  expect(prViewArgs('https://github.com/a/b/pull/1')).toEqual(['pr', 'view', 'https://github.com/a/b/pull/1', '--json', 'number,title,state,isDraft,reviewDecision,statusCheckRollup,mergeStateStatus'])
  expect([prNumber('#18 open'), prNumber('#18')]).toEqual(['#18', '#18'])
})

const run = (name: string, status: string, conclusion = '', at = '') => ({ __typename: 'CheckRun', workflowName: 'CI', name, status, conclusion, startedAt: at, completedAt: at })
const ctx = (context: string, state: string, at = '') => ({ __typename: 'StatusContext', context, state, startedAt: at })

test('the rollup summary: CheckRuns and StatusContexts mixed, empty, draft, merged and closed', () => {
  const mixed = prSummary({ state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', statusCheckRollup: [run('build', 'COMPLETED', 'FAILURE'), run('test', 'COMPLETED', 'TIMED_OUT'), ctx('ci/lint', 'ERROR'), run('docs', 'IN_PROGRESS'), ctx('deploy', 'SUCCESS'), run('build', 'COMPLETED', 'CANCELLED')] }, NOW)
  expect(mixed).toEqual({ state: 'open', title: null, checks: 'failing', failing: ['test', 'ci/lint', 'build'], review: 'approved', checkedAt: NOW })
  expect(prSummary({ state: 'OPEN', statusCheckRollup: [run('a', 'QUEUED'), ctx('b', 'SUCCESS'), ctx('c', 'EXPECTED')] }, NOW)?.checks).toBe('pending')
  expect(prSummary({ state: 'OPEN', statusCheckRollup: [run('a', 'COMPLETED', 'SUCCESS'), run('b', 'COMPLETED', 'SKIPPED'), run('c', 'COMPLETED', 'NEUTRAL')] }, NOW)?.checks).toBe('passing')
  expect(prSummary({ state: 'OPEN', statusCheckRollup: [run('a', 'COMPLETED', 'ACTION_REQUIRED'), run('b', 'COMPLETED', 'STARTUP_FAILURE')] }, NOW)?.failing).toEqual(['a', 'b'])
  const empty = prSummary({ state: 'OPEN', isDraft: true, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [] }, NOW)
  expect([empty?.state, empty?.checks, empty?.review]).toEqual(['draft', 'none', 'required'])
  expect(prSummary({ state: 'MERGED', isDraft: false, statusCheckRollup: null }, NOW)?.state).toBe('merged')
  expect(prSummary({ state: 'CLOSED', reviewDecision: 'CHANGES_REQUESTED' }, NOW)?.review).toBe('changes')
  expect(prSummary({ state: 'OPEN', statusCheckRollup: Array.from({ length: 9 }, (_, i) => run(`c${i}`, 'COMPLETED', 'FAILURE')) }, NOW)?.failing.length).toBe(5)
  expect(prSummary(null, NOW)).toBeNull()
})

test('the PR title: one line, control and direction-override characters dropped, at most 200 characters', () => {
  expect(prSummary({ state: 'OPEN', title: '  Add\n a\u202e PR\tfield ' }, NOW)?.title).toBe('Add a PR field')
  expect(prSummary({ state: 'OPEN', title: 'x'.repeat(300) }, NOW)?.title).toHaveLength(200)
  expect(prSummary({ state: 'OPEN', title: ' \u200b ' }, NOW)?.title).toBeNull()
  expect(prSummary({ state: 'OPEN', title: 42 }, NOW)?.title).toBeNull()
})

test('re-runs: a passed re-run hides the failure before it, whatever the order gh lists them; a newer failure wins', () => {
  const failed = run('build', 'COMPLETED', 'FAILURE', '2026-11-07T10:00:00Z')
  const passed = run('build', 'COMPLETED', 'SUCCESS', '2026-11-07T10:10:00Z')
  expect(prSummary({ state: 'OPEN', statusCheckRollup: [failed, passed] }, NOW)?.checks).toBe('passing')
  expect(prSummary({ state: 'OPEN', statusCheckRollup: [passed, failed] }, NOW)?.checks).toBe('passing')
  const later = run('build', 'COMPLETED', 'FAILURE', '2026-11-07T10:20:00Z')
  expect(prSummary({ state: 'OPEN', statusCheckRollup: [failed, passed, later] }, NOW)?.failing).toEqual(['build'])
  const statuses = [ctx('ci/lint', 'FAILURE', '2026-11-07T10:00:00Z'), ctx('ci/lint', 'SUCCESS', '2026-11-07T10:05:00Z')]
  expect(prSummary({ state: 'OPEN', statusCheckRollup: statuses }, NOW)?.checks).toBe('passing')
  const otherWorkflow = { ...failed, workflowName: 'Nightly' }
  expect(latestChecks([otherWorkflow, passed]).length).toBe(2)
})

const status = (patch: Partial<PrStatus> = {}): PrStatus => ({ state: 'open', checks: 'passing', failing: [], review: null, checkedAt: NOW, ...patch })

test('gh refresh pacing: open every 2 min, merged or closed hourly, failed reads every 10 min; missing, signed out or rate limited gh backs off', () => {
  expect(isPrDue(undefined, NOW)).toBe(true)
  expect(isPrDue({ status: status(), checkedAt: NOW - 60_000, failed: false }, NOW)).toBe(false)
  expect(isPrDue({ status: status(), checkedAt: NOW - 2 * 60_000, failed: false }, NOW)).toBe(true)
  expect(isPrDue({ status: status({ state: 'merged' }), checkedAt: NOW - 30 * 60_000, failed: false }, NOW)).toBe(false)
  expect(isPrDue({ status: status({ state: 'closed' }), checkedAt: NOW - 61 * 60_000, failed: false }, NOW)).toBe(true)
  expect(isPrDue({ status: null, checkedAt: NOW - 5 * 60_000, failed: true }, NOW)).toBe(false)
  expect(ghUnavailable('', 'ENOENT')).toBe('not installed')
  expect(ghUnavailable('To get started with GitHub CLI, please run:  gh auth login', 4)).toBe('not signed in')
  expect(ghUnavailable('GraphQL: API rate limit exceeded for user', 1)).toBe('rate limited')
  expect(ghUnavailable('GraphQL: Could not resolve to a PullRequest', 1)).toBeNull()
})


const tool = (at: number, patch: Partial<ToolRecord> = {}): ToolRecord => ({ at, tool: 'Bash', category: 'shell', target: 'npm', isError: false, agentId: null, ...patch })
const failingEdit = (at: number, isError: boolean) => tool(at, { tool: 'Edit', category: 'edit', target: 'finder.py', isError })

test('maybe stuck, repeat: the same call failing back to back is flagged; another call between, no failures, or a success last, are not', () => {
  const start = NOW - 5 * 60_000
  const looping = [tool(NOW - 240_000), failingEdit(NOW - 120_000, true), failingEdit(NOW - 60_000, false), failingEdit(NOW - 10_000, true)]
  expect(stuckOf(looping, NOW, 'running', start)).toEqual({ kind: 'repeat', text: 'Same call 3 times, 2 failed: Edit finder.py', since: NOW - 120_000 })
  const editBetween = [failingEdit(NOW - 120_000, true), tool(NOW - 90_000, { tool: 'Edit', category: 'edit', target: 'other.py' }), failingEdit(NOW - 60_000, true), failingEdit(NOW - 10_000, true)]
  expect(stuckOf(editBetween, NOW, 'running', start)).toBeNull()
  expect(stuckOf([failingEdit(NOW - 120_000, false), failingEdit(NOW - 60_000, false), failingEdit(NOW - 10_000, false)], NOW, 'running', start)).toBeNull()
  const recovered = [failingEdit(NOW - 120_000, true), failingEdit(NOW - 60_000, true), failingEdit(NOW - 10_000, false)]
  expect(stuckOf(recovered, NOW, 'running', start)).toBeNull()
  const subagentBetween = [failingEdit(NOW - 120_000, true), tool(NOW - 90_000, { agentId: 'a1', isError: true }), failingEdit(NOW - 60_000, false), failingEdit(NOW - 10_000, true)]
  expect(stuckOf(subagentBetween, NOW, 'running', start)?.kind).toBe('repeat')
  expect(stuckOf(looping, NOW, 'idle', start)).toBeNull()
  expect(stuckOf(looping, NOW, 'waiting-user', start)).toBeNull()
  expect(stuckOf(looping, NOW, 'running', NOW - 30_000)).toBeNull()
  expect(stuckOf(looping, NOW + STUCK.repeatWindowMs, 'running', start)).toBeNull()
})

test("maybe stuck, errors: 4 of the last 6 main calls failing in 10 minutes, the latest among them; fewer, older, recovered or a subagent's do not count", () => {
  const start = NOW - 20 * 60_000
  const calls = [true, false, true, true, false, true].map((isError, i) => tool(NOW - (6 - i) * 30_000, { target: `t${i}`, isError }))
  expect(stuckOf(calls, NOW, 'running', start)).toEqual({ kind: 'errors', text: '4 of the last 6 calls failed', since: NOW - 180_000 })
  expect(stuckOf(calls.map((c, i) => (i === 0 ? { ...c, isError: false } : c)), NOW, 'running', start)).toBeNull()
  expect(stuckOf([...calls.slice(1), tool(NOW - 5_000, { target: 'ok' })], NOW, 'running', start)).toBeNull()
  expect(stuckOf(calls.map(c => ({ ...c, agentId: 'a1' })), NOW, 'running', start)).toBeNull()
  expect(stuckOf(calls, NOW + 9 * 60_000, 'running', start)).toBeNull()
  expect(stuckOf(calls, NOW, 'stale', start)).toBeNull()
  expect(stuckOf([...calls, tool(NOW - 1_000, { tool: 'BashOutput', target: 'shell' })], NOW, 'running', start)?.kind).toBe('errors')
})
