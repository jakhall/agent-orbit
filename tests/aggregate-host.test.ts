import { expect, test } from 'claude-code/testing'

import type { PublishedSession } from '../types'
import type { Paths } from '../src/paths'
import { aggregate, createListingCache, createReaders, listingOf } from '../shared/aggregate/aggregate.js'
import { branchOf, createBranchCache } from '../shared/aggregate/git.js'
import { createDesktopCache, scanDesktop } from '../shared/aggregate/desktop.js'
import { defaultPrefs } from '../src/core/prefs'
import { NOW, pub } from './fixtures'

const DATA = 'C:\\Users\\t\\.claude\\orbit'
const LEGACY = 'C:\\Users\\t\\.claude\\agent-constellation\\sessions'
const PATHS = {
  sep: '\\',
  data: DATA,
  sessionsDir: `${DATA}\\sessions`,
  inboxDir: `${DATA}\\inbox`,
  snapshotV2: `${DATA}\\snapshot-v2.json`,
  prefs: `${DATA}\\prefs.json`,
  companion: `${DATA}\\companion.json`,
  desktopRoot: null,
  projectsDir: 'C:\\Users\\t\\.claude\\projects',
  pluginRoot: 'C:\\mods\\orbit',
  system32: 'C:\\Windows\\System32',
} as Paths

function host(store: Map<string, string>, mtimes: Map<string, number>) {
  const stat = async (path: string) => {
    const text = store.get(path)
    if (text === undefined) throw new Error('ENOENT')
    return { kind: 'file', size: text.length, mtimeMs: mtimes.get(path) ?? NOW, isLink: false }
  }
  return {
    fs: {
      list: async (dir: string) => {
        const prefix = `${dir}\\`
        const names = [...store.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('\\'))
        if (names.length === 0) throw new Error('ENOENT')
        return Promise.all(names.map(async p => ({ name: p.slice(prefix.length), ...(await stat(p)) })))
      },
      read: async (path: string) => {
        const text = store.get(path)
        if (text === undefined) throw new Error('ENOENT')
        return text
      },
      stat,
      exists: async (path: string) => store.has(path),
    },
  }
}

function record(id: string, updatedAt: number, cwd: string, patch: Partial<PublishedSession> = {}): string {
  return JSON.stringify(
    pub({
      cliSessionId: id,
      entrypoint: 'cli',
      cwd,
      repoRoot: cwd,
      startedAt: updatedAt - 60_000,
      updatedAt,
      heartbeatAt: updatedAt,
      turn: { isRunning: true, startedAt: updatedAt - 30_000, endedAt: null, lastReason: null },
      ...patch,
    }),
  )
}

function context(readers = createReaders(), now = NOW) {
  const prefs = defaultPrefs()
  return { paths: PATHS, readers, settings: prefs.settings, me: 'orbit-server', now, pinned: [] }
}

test('records in the 1.0 folder are no longer read; current records are still re-redacted on read (X-1)', async () => {
  const store = new Map<string, string>([
    [`${LEGACY}\\old-1.json`, record('old-1', NOW - 5_000, 'C:\\repo\\old')],
    [
      `${DATA}\\sessions\\new-1.json`,
      record('new-1', NOW - 1_000, 'C:\\repo\\new', { repoRemote: 'https://jak:ghp_remote@github.com/o/r.git' }),
    ],
  ])
  const snapshot = await aggregate(host(store, new Map()), context())
  const keys = snapshot.sessions.map(s => s.key)
  expect(keys).toEqual(['cli:new-1'])
  expect(JSON.stringify(snapshot)).not.toMatch(/ghp_/)
  expect('legacy' in snapshot.sources.publishers).toBe(false)
})

test('a publisher record read mid-write is read again at the same file time, not missing for a week (E-82)', async () => {
  const path = `${DATA}\\sessions\\half-1.json`
  const store = new Map<string, string>([[path, '{"schema":1,"cliSess']])
  const mtimes = new Map<string, number>([[path, NOW - 1_000]])
  const readers = createReaders()
  const first = await aggregate(host(store, mtimes), context(readers))
  expect(first.sessions.some(s => s.key === 'cli:half-1')).toBe(false)
  store.set(path, record('half-1', NOW - 1_000, 'C:\\repo\\half'))
  let isSeen = false
  for (let t = 1; t <= 40 && !isSeen; t += 1) isSeen = (await aggregate(host(store, mtimes), context(readers, NOW + t * 1_000))).sessions.some(s => s.key === 'cli:half-1')
  expect(isSeen).toBe(true)
})

test('timelines in the snapshot keep the 12 newest entries (E-119)', async () => {
  const timeline = Array.from({ length: 30 }, (_, i) => ({ at: NOW - 60_000 + i * 1_000, kind: 'tool' as const, text: `Step ${i}` }))
  const store = new Map<string, string>([[`${DATA}\\sessions\\long-1.json`, record('long-1', NOW - 1_000, 'C:\\repo\\a', { timeline })]])
  const snapshot = await aggregate(host(store, new Map()), context())
  const session = snapshot.sessions.find(s => s.key === 'cli:long-1')
  expect(session?.timeline.length).toBe(12)
  expect(session?.timeline[0]?.text).toBe('Step 29')
})

test('the desktop scan says how many records it left past the cap, and caches only the fields Orbit reads (E-18, E-118)', async () => {
  const root = 'R'
  const records = Array.from({ length: 5 }, (_, i) => `local_0a1b2c3d-0000-4000-8000-00000000000${i}`)
  const big = 'x'.repeat(50_000)
  const fake = {
    fs: {
      exists: async () => true,
      list: async (path: string) => {
        if (path === root) return [{ name: 'acct', kind: 'dir', size: 0, mtimeMs: NOW, isLink: false }]
        if (path === `${root}\\acct`) return [{ name: 'org', kind: 'dir', size: 0, mtimeMs: NOW, isLink: false }]
        return records.map((id, i) => ({ name: `${id}.json`, kind: 'file', size: 10, mtimeMs: NOW - i * 1_000, isLink: false }))
      },
      read: async (path: string) => {
        const id = path.split('\\').at(-1)?.replace('.json', '') ?? ''
        return JSON.stringify({ sessionId: id, cliSessionId: `cli-${id}`, lastActivityAt: NOW, title: 'T', messages: [big], queryCrashes: [{ at: 1, errorCategory: 'old' }, { at: 2, errorCategory: 'new' }] })
      },
      stat: async () => ({ kind: 'file', size: 10, mtimeMs: NOW, isLink: false }),
    },
  }
  const cache = createDesktopCache()
  const scan = await scanDesktop(fake, cache, root, '\\', 3)
  expect(scan.sessions.length).toBe(3)
  expect(scan.files).toBe(5)
  expect(scan.skipped).toBe(2)
  const cached = [...cache.values()].map(e => JSON.stringify(e.raw))
  expect(cached.length).toBe(3)
  expect(cached.every(text => !text.includes('messages') && text.length < 1_000)).toBe(true)
  expect(scan.sessions[0]?.failure?.category).toBe('new')
})

test('transcript folder listings are kept for 45 s and one stale folder is listed again per run (E-108)', async () => {
  const lists: string[] = []
  const fake = {
    fs: {
      list: async (path: string) => {
        lists.push(path)
        return [{ name: 'a.jsonl', kind: 'file', size: 1, mtimeMs: NOW, isLink: false }]
      },
    },
  }
  const cache = createListingCache()
  const run = async (now: number) => {
    const budget = { left: 1 }
    for (const dir of ['P1', 'P2', 'P3']) await listingOf(fake, cache, '\\', 'R', dir, now, budget)
  }
  await run(NOW)
  expect(lists.length).toBe(3)
  await run(NOW + 10_000)
  expect(lists.length).toBe(3)
  await run(NOW + 50_000)
  expect(lists.length).toBe(4)
  await run(NOW + 51_000)
  await run(NOW + 52_000)
  expect(lists.length).toBe(6)
  expect(new Set(lists.slice(3))).toEqual(new Set(['R\\P1', 'R\\P2', 'R\\P3']))
})

test('branch reads are staggered: at most 3 cached checkouts are read again per run, none older than 5 min kept (E-109)', async () => {
  let reads = 0
  const fake = {
    fs: {
      stat: async () => ({ kind: 'dir', size: 0, mtimeMs: NOW, isLink: false }),
      read: async () => {
        reads += 1
        return 'ref: refs/heads/main\n'
      },
    },
  }
  const cache = createBranchCache()
  const roots = Array.from({ length: 10 }, (_, i) => `C:\\repo${i}`)
  const run = async (now: number) => {
    const budget = { left: 3 }
    for (const root of roots) await branchOf(fake as never, cache, '\\', root, now, budget)
  }
  await run(NOW)
  expect(reads).toBe(10)
  await run(NOW + 61_000)
  expect(reads).toBe(13)
  await run(NOW + 62_000)
  expect(reads).toBe(16)
  await run(NOW + 7 * 60_000)
  expect(reads).toBe(26)
})

test('2.1: sessions editing two worktrees of one repository group under that repository, each keeping its checkout as a worktree; another repository stays separate', async () => {
  const repo = 'C:\\r\\Nodes'
  const engine = 'C:\\r\\Nodes-engine'
  const ui = 'C:\\r\\Nodes-ui'
  const other = 'C:\\r\\Skynet'
  const store = new Map<string, string>([
    [`${DATA}\\sessions\\s-engine.json`, record('s-engine', NOW - 1_000, repo)],
    [`${DATA}\\sessions\\s-ui.json`, record('s-ui', NOW - 2_000, repo)],
    [`${DATA}\\sessions\\s-scratch.json`, record('s-scratch', NOW - 3_000, 'C:\\r\\scratch')],
    [`${DATA}\\sessions\\s-other.json`, record('s-other', NOW - 4_000, repo)],
  ])
  const editRoots = new Map([
    ['cli:s-engine', new Map([[engine, 5]])],
    ['cli:s-ui', new Map([[ui, 3], [engine, 1]])],
    ['cli:s-scratch', new Map([[engine, 2], [ui, 2]])],
    ['cli:s-other', new Map([[other, 4]])],
  ])
  const repositoryOf = (checkout: string) => (checkout === engine || checkout === ui ? repo : checkout)
  const snapshot = await aggregate(host(store, new Map()), { ...context(), editRoots, repositoryOf, home: 'C:\\Users\\t' })
  const of = (key: string) => snapshot.sessions.find(x => x.key === key)!
  expect([of('cli:s-engine').projectId, of('cli:s-ui').projectId, of('cli:s-scratch').projectId]).toEqual(['c:\\r\\nodes', 'c:\\r\\nodes', 'c:\\r\\nodes'])
  expect([of('cli:s-engine').projectSource, of('cli:s-scratch').projectSource]).toEqual(['folder', 'edits'])
  expect(of('cli:s-scratch').worktreeId).toBe('c:\\r\\nodes-engine')
  expect(of('cli:s-other').projectId).toBe('c:\\r\\skynet')
})

test('2.1.5: a session counts only a real checkout of its repository as its worktree, never ~/.claude or a folder that is not one', async () => {
  const repo = 'C:\\r\\Nodes'
  const store = new Map<string, string>([
    [`${DATA}\\sessions\\s-home.json`, record('s-home', NOW - 1_000, 'C:\\Users\\t\\.claude', { repoRoot: repo })],
    [`${DATA}\\sessions\\s-gone.json`, record('s-gone', NOW - 2_000, 'C:\\r\\Nodes-gone', { repoRoot: repo })],
    [`${DATA}\\sessions\\s-linked.json`, record('s-linked', NOW - 3_000, 'C:\\r\\Nodes-ui', { repoRoot: repo })],
    [`${DATA}\\sessions\\s-desk.json`, record('s-desk', NOW - 4_000, `${repo}\\.claude\\worktrees\\fix`, { repoRoot: repo })],
  ])
  const repositoryOf = (checkout: string) => (checkout === 'C:\\r\\Nodes-ui' ? repo : checkout)
  const snapshot = await aggregate(host(store, new Map()), { ...context(), repositoryOf, home: 'C:\\Users\\t' })
  const of = (key: string) => snapshot.sessions.find(x => x.key === key)!
  const keys = ['s-home', 's-gone', 's-linked', 's-desk']
  expect(keys.map(k => of(`cli:${k}`).projectId)).toEqual(Array(4).fill('c:\\r\\nodes'))
  expect(keys.map(k => of(`cli:${k}`).worktreeId)).toEqual([null, null, 'c:\\r\\nodes-ui', 'c:\\r\\nodes\\.claude\\worktrees\\fix'])
  expect(snapshot.projects.find(p => p.id === 'c:\\r\\nodes')!.worktreeIds.sort()).toEqual(['c:\\r\\nodes-ui', 'c:\\r\\nodes\\.claude\\worktrees\\fix'])
})

test('a name and icon colour saved in Orbit replace the session title and keep the original as renamedFrom', async () => {
  const store = new Map<string, string>([[`${DATA}\\sessions\\named-1.json`, record('named-1', NOW - 1_000, 'C:\\repo\\named')]])
  const plain = await aggregate(host(store, new Map()), context())
  const original = plain.sessions.find(s => s.key === 'cli:named-1')!
  expect(original.renamedFrom).toBe(undefined)
  expect(original.tint).toBe(undefined)
  const snapshot = await aggregate(host(store, new Map()), { ...context(), titles: { 'cli:named-1': 'Login fix' }, tints: { 'cli:named-1': 'teal' } })
  const s = snapshot.sessions.find(x => x.key === 'cli:named-1')!
  expect([s.title, s.renamedFrom, s.tint]).toEqual(['Login fix', original.title, 'teal'])
})

test('a project colour is the icon colour of its sessions that have none of their own, and of the project', async () => {
  const store = new Map<string, string>([
    [`${DATA}\\sessions\\red-1.json`, record('red-1', NOW - 1_000, 'C:\\repo\\red')],
    [`${DATA}\\sessions\\red-2.json`, record('red-2', NOW - 2_000, 'C:\\repo\\red')],
    [`${DATA}\\sessions\\red-3.json`, record('red-3', NOW - 3_000, 'C:\\repo\\red')],
  ])
  const plain = await aggregate(host(store, new Map()), context())
  const projectId = plain.sessions.find(s => s.key === 'cli:red-1')!.projectId
  const snapshot = await aggregate(host(store, new Map()), { ...context(), projectTints: { [projectId]: 'red' }, tints: { 'cli:red-2': 'lime', 'cli:red-3': 'blue' } })
  const tint = (key: string) => snapshot.sessions.find(x => x.key === key)!.tint
  expect([tint('cli:red-1'), tint('cli:red-2'), tint('cli:red-3')]).toEqual(['red', 'lime', 'blue'])
  expect(snapshot.projects.find(p => p.id === projectId)!.tint).toBe('red')
  expect(plain.projects.find(p => p.id === projectId)!.tint).toBe(undefined)
})
