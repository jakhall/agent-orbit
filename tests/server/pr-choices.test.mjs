import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeDesktop } from '../../shared/aggregate/desktop.js'
import { filterPrChoices, PR_CHOICES_MAX, prChoiceDetail, prChoiceTitle, prChoices, prFromInput, prLinkOf } from '../../shared/pr-links.js'

const pr = (repo, number, extra = {}) => ({ url: `https://github.com/${repo}/pull/${number}`, number, repo, branch: null, state: 'OPEN', ...extra })
const session = (key, projectId, lastActivityAt, prs, cwd = null) => ({ key, projectId, lastActivityAt, prs, cwd })

const snapshot = {
  projects: [
    { id: 'p-app', root: 'C:\\src\\app' },
    { id: 'p-web', root: 'C:\\src\\web' },
  ],
  sessions: [
    session('old-app', 'p-app', 100, [pr('acme/app', 3)]),
    session('mine', 'p-app', 500, [pr('acme/app', 7), pr('acme/app', 8, { dismissed: true })]),
    session('new-app', 'p-app', 900, [pr('acme/app', 9), pr('acme/app', 7)]),
    session('other-folder', 'p-fork', 800, [pr('acme/app', 11)]),
    session('web', 'p-web', 950, [pr('acme/web', 1)], 'C:\\src\\web'),
  ],
}

test('a session sees its own PRs first, then its project and repository, newest first', () => {
  const urls = prChoices(snapshot, { sessionKey: 'mine' }).map(c => `${c.number}${c.isSessions ? '*' : ''}`)
  assert.deepEqual(urls, ['7*', '9', '11', '3'])
})

test('dismissed links and other repositories are left out', () => {
  const numbers = prChoices(snapshot, { sessionKey: 'mine' }).map(c => c.number)
  assert.ok(!numbers.includes(8))
  assert.ok(!numbers.includes(1))
})

test('a folder finds its project by root or by a session started there', () => {
  assert.deepEqual(prChoices(snapshot, { folder: 'c:/src/app/' }).map(c => c.number), [9, 7, 11, 3])
  assert.deepEqual(prChoices(snapshot, { folder: 'C:\\src\\web' }).map(c => c.number), [1])
  assert.deepEqual(prChoices(snapshot, { folder: 'C:\\nowhere' }), [])
  assert.deepEqual(prChoices(null, { sessionKey: 'mine' }), [])
})

test('the list is capped', () => {
  const many = { projects: [], sessions: [session('s', 'p', 1, Array.from({ length: 30 }, (_, i) => pr('acme/app', i + 1)))] }
  assert.equal(prChoices(many, { sessionKey: 's' }).length, PR_CHOICES_MAX)
})

test('a pasted link is reduced to the plain PR URL or refused', () => {
  assert.equal(prLinkOf('  https://github.com/acme/app/pull/42/files?w=1#diff  '), 'https://github.com/acme/app/pull/42')
  assert.equal(prLinkOf('https://github.com/acme/app/pull/42/'), 'https://github.com/acme/app/pull/42')
  assert.equal(prLinkOf('https://github.com/acme/app/issues/42'), null)
  assert.equal(prLinkOf('http://github.com/acme/app/pull/42'), null)
  assert.equal(prLinkOf('https://evil.example/acme/app/pull/42'), null)
  assert.equal(prLinkOf('42'), null)
  assert.equal(prLinkOf(null), null)
})

test('desktop records keep dismissed only when it is true', () => {
  const raw = { sessionId: 'local_0a1b2c3d-0000-4000-8000-0000000000f1', prs: [{ url: 'https://github.com/acme/app/pull/1', prNumber: 1, dismissed: true }, { url: 'https://github.com/acme/app/pull/2', prNumber: 2, dismissed: 'yes' }] }
  const d = normalizeDesktop(raw, 0, new Set())
  assert.deepEqual(d?.prs.map(p => p.dismissed), [true, undefined])
})

test('the Pull request field takes a link, an offered number, or nothing', () => {
  const choices = prChoices(snapshot, { sessionKey: 'mine' })
  assert.equal(prFromInput('   ', choices), '')
  assert.equal(prFromInput('#9', choices), 'https://github.com/acme/app/pull/9')
  assert.equal(prFromInput('7', choices), 'https://github.com/acme/app/pull/7')
  assert.equal(prFromInput('#99', choices), null)
  assert.equal(prFromInput('https://github.com/other/repo/pull/5/files', choices), 'https://github.com/other/repo/pull/5')
  assert.equal(prFromInput('not a link', choices), null)
})

const choice = (extra = {}) => ({ url: 'https://github.com/acme/app/pull/42', number: 42, repo: 'acme/app', branch: 'pr-field', state: 'OPEN', isSessions: true, ...extra })
const status = (extra = {}) => ({ state: 'open', title: 'Add a PR field', checks: 'passing', failing: [], review: null, checkedAt: 1, ...extra })

test('an offered PR shows its title, else its branch, else repository and number', () => {
  assert.equal(prChoiceTitle(choice(), status()), 'Add a PR field')
  assert.equal(prChoiceTitle(choice(), null), 'pr-field')
  assert.equal(prChoiceTitle(choice({ branch: null }), status({ title: null })), 'acme/app #42')
})

test('an offered PR’s second line holds repository, number, state, checks and the branch under a title', () => {
  assert.equal(prChoiceDetail(choice(), status()), 'acme/app #42 · open · checks passing · pr-field')
  assert.equal(prChoiceDetail(choice(), status({ checks: 'failing', review: 'changes' })), 'acme/app #42 · open · checks failing · changes requested · pr-field')
  assert.equal(prChoiceDetail(choice(), status({ state: 'merged', checks: 'failing' })), 'acme/app #42 · merged · pr-field')
  assert.equal(prChoiceDetail(choice({ state: 'MERGED' }), null), 'acme/app #42 · merged')
  assert.equal(prChoiceDetail(choice({ state: 'UNKNOWN' }), null), 'acme/app #42')
})

test('typing filters offered PRs by title, branch, repository or number', () => {
  const a = choice()
  const b = choice({ url: 'https://github.com/acme/web/pull/7', number: 7, repo: 'acme/web', branch: 'fix-login' })
  const statuses = { [a.url]: status() }
  const pick = (/** @type {string} */ text) => filterPrChoices([a, b], text, statuses).map(c => c.number)
  assert.deepEqual(pick(''), [42, 7])
  assert.deepEqual(pick('pr FIELD'), [42])
  assert.deepEqual(pick('login'), [7])
  assert.deepEqual(pick('#7'), [7])
  assert.deepEqual(pick('acme/web'), [7])
  assert.deepEqual(pick('nothing'), [])
  assert.deepEqual(pick('https://github.com/x/y/pull/1'), [42, 7])
})
