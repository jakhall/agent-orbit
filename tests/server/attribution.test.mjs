import assert from 'node:assert/strict'
import test from 'node:test'

import { attributeProject, isCheckoutOf, isWeakRoot, repositoryOfCheckout, rootCounts } from '../../shared/aggregate/attribution.js'

const HOME = 'C:\\Users\\jak'

test('weak roots: the profile, ~/.claude and install folders; a repository under the profile is not weak (G-17)', () => {
  for (const p of [HOME, `${HOME}\\.claude`, `${HOME}\\.claude\\worktrees\\x`, 'C:\\Program Files\\App', `${HOME}\\AppData\\Local\\Programs\\x`, `${HOME}\\AppData\\Roaming\\Claude`, 'C:\\Windows\\System32', 'C:\\']) {
    assert.equal(isWeakRoot(p, HOME), true, p)
  }
  for (const p of [`${HOME}\\Documents\\Github\\Nodes`, 'D:\\src\\api']) assert.equal(isWeakRoot(p, HOME), false, p)
})

test('2.1.5: a checkout of a project is its repository, a folder inside it or a linked worktree pointing back; never a weak place', () => {
  const root = 'C:\\r\\Nodes'
  const linked = (/** @type {string} */ checkout) => (checkout === 'C:\\r\\Nodes-ui' ? root : checkout)
  assert.equal(isCheckoutOf({ checkout: 'c:\\r\\nodes', root, home: HOME, repositoryOf: linked }), true)
  assert.equal(isCheckoutOf({ checkout: `${root}\\.claude\\worktrees\\fix`, root, home: HOME, repositoryOf: linked }), true)
  assert.equal(isCheckoutOf({ checkout: 'C:\\r\\Nodes-ui', root, home: HOME, repositoryOf: linked }), true)
  assert.equal(isCheckoutOf({ checkout: 'C:\\r\\Nodes-gone', root, home: HOME, repositoryOf: linked }), false)
  assert.equal(isCheckoutOf({ checkout: `${HOME}\\.claude`, root, home: HOME, repositoryOf: linked }), false)
  assert.equal(isCheckoutOf({ checkout: `${HOME}\\.claude`, root, home: HOME }), false)
  assert.equal(isCheckoutOf({ checkout: 'C:\\r\\Nodes-gone', root, home: HOME }), true)
  assert.equal(isCheckoutOf({ checkout: `${HOME}\\.claude`, root: `${HOME}\\.claude`, home: HOME }), true)
})

test('the repository most edits land in wins over the start folder; ties go to the start folder, then by name (G-17)', () => {
  const edits = rootCounts([`${HOME}\\Documents\\app\\a.ts`, `${HOME}\\Documents\\app\\b.ts`, `${HOME}\\Documents\\lib\\c.ts`], p => (p.includes('\\app\\') ? `${HOME}\\Documents\\app` : `${HOME}\\Documents\\lib`))
  assert.deepEqual(attributeProject({ startRoot: `${HOME}\\.claude`, editRoots: edits, override: null, home: HOME }), { root: `${HOME}\\Documents\\app`, source: 'edits', worktree: `${HOME}\\Documents\\app` })
  const tie = new Map([[`${HOME}\\Documents\\lib`, 1], [`${HOME}\\Documents\\app`, 1]])
  assert.deepEqual(attributeProject({ startRoot: `${HOME}\\Documents\\lib`, editRoots: tie, override: null, home: HOME }), { root: `${HOME}\\Documents\\lib`, source: 'folder', worktree: null })
  assert.deepEqual(attributeProject({ startRoot: `${HOME}\\.claude`, editRoots: tie, override: null, home: HOME }).root, `${HOME}\\Documents\\app`)
})

test('edits only in weak places, or none, keep the start folder; an override beats everything (G-17)', () => {
  const weak = new Map([[`${HOME}\\.claude`, 9]])
  assert.deepEqual(attributeProject({ startRoot: 'D:\\src\\api', editRoots: weak, override: null, home: HOME }), { root: 'D:\\src\\api', source: 'folder', worktree: null })
  assert.deepEqual(attributeProject({ startRoot: 'D:\\src\\api', editRoots: new Map(), override: null, home: HOME }), { root: 'D:\\src\\api', source: 'folder', worktree: null })
  assert.deepEqual(attributeProject({ startRoot: 'D:\\src\\api', editRoots: new Map([['D:\\src\\web', 3]]), override: 'd:\\src\\other', home: HOME }), { root: 'd:\\src\\other', source: 'override', worktree: null })
})

test('edits in the start repository keep it as the folder, not as edits (G-17)', () => {
  assert.deepEqual(attributeProject({ startRoot: 'D:\\src\\api', editRoots: new Map([['d:\\src\\api', 4]]), override: null, home: HOME }), { root: 'D:\\src\\api', source: 'folder', worktree: null })
})

test('prefs keep project overrides as short plain strings only (G-17)', async () => {
  const { sanitizePrefs } = await import('../../shared/prefs.js')
  const raw = JSON.parse('{"projectOverrides":{"__proto__":"x","local_a":"  d:/src/api  ","local_b":7,"local_c":"","":"y","local_d":"' + 'z'.repeat(401) + '"}}')
  assert.deepEqual(sanitizePrefs(raw).projectOverrides, { local_a: 'd:/src/api' })
  assert.deepEqual(sanitizePrefs({}).projectOverrides, {})
})

test('a record\'s error trace is read back with its four fields only, kinds and places from a fixed set (E-29)', async () => {
  const { cleanRecord } = await import('../../shared/aggregate/redact.js')
  const base = { schema: 1, cliSessionId: 'c', tools: [], timeline: [], agents: [], turn: null }
  assert.deepEqual(cleanRecord({ ...base, errors: { count: 3, lastAt: 5, where: 'inbox', kind: 'TypeError', message: 'C:\secret' } }).errors, { count: 3, lastAt: 5, where: 'inbox', kind: 'TypeError' })
  assert.equal(cleanRecord({ ...base, errors: { count: 1, lastAt: 5, where: 'elsewhere', kind: 'x' } }).errors, undefined)
  assert.deepEqual(cleanRecord({ ...base, errors: { count: 1, lastAt: 5, where: 'tick', kind: 'C:\path with spaces' } }).errors, { count: 1, lastAt: 5, where: 'tick', kind: 'Error' })
  assert.equal(cleanRecord(base).errors, undefined)
})

const REPO = 'C:\\r\\Nodes'
const ENGINE = 'C:\\r\\Nodes-engine'
const UI = 'C:\\r\\Nodes-ui'
const OTHER = 'C:\\r\\Skynet'
const repositoryOf = checkout => (checkout === ENGINE || checkout === UI ? REPO : checkout)

test('2.1: a linked worktree belongs to its repository (its .git file points into <repo>/.git/worktrees); a main checkout or a submodule is its own', () => {
  assert.equal(repositoryOfCheckout(ENGINE, 'gitdir: C:/r/Nodes/.git/worktrees/Nodes-engine\n'), REPO)
  assert.equal(repositoryOfCheckout(UI, 'gitdir: ../Nodes/.git/worktrees/Nodes-ui'), REPO)
  assert.equal(repositoryOfCheckout(REPO, null), REPO)
  assert.equal(repositoryOfCheckout('C:\\r\\Nodes\\vendor\\lib', 'gitdir: ../../.git/modules/lib'), 'C:\\r\\Nodes\\vendor\\lib')
  assert.equal(repositoryOfCheckout(ENGINE, 'not a pointer'), ENGINE)
})

test('2.1: edits in two worktrees of one repository count for that repository, which is the session\'s own, so it stays its folder (1.15 grouping)', () => {
  const decided = attributeProject({ startRoot: REPO, editRoots: new Map([[ENGINE, 5], [UI, 2]]), override: null, home: HOME, repositoryOf })
  assert.deepEqual(decided, { root: REPO, source: 'folder', worktree: null })
})

test('2.1: edits in another repository still move a session there, with the checkout they land in as its worktree; an override still wins', () => {
  const startedElsewhere = attributeProject({ startRoot: 'C:\\r\\scratch', editRoots: new Map([[ENGINE, 5], [UI, 4]]), override: null, home: HOME, repositoryOf })
  assert.deepEqual(startedElsewhere, { root: REPO, source: 'edits', worktree: ENGINE })
  const other = attributeProject({ startRoot: REPO, editRoots: new Map([[OTHER, 6], [ENGINE, 2]]), override: null, home: HOME, repositoryOf })
  assert.deepEqual(other, { root: OTHER, source: 'edits', worktree: OTHER })
  assert.deepEqual(attributeProject({ startRoot: REPO, editRoots: new Map([[OTHER, 6]]), override: UI, home: HOME, repositoryOf }), { root: UI, source: 'override', worktree: null })
})
