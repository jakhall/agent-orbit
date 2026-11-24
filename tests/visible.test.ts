import { expect, test } from 'claude-code/testing'

import type { SessionView } from '../types'
import { DEFAULT_FILTERS, DEFAULT_SETTINGS } from '../shared/constants.js'
import { normalizeSnapshot, visibleOf } from '../shared/filters.js'
import { buildSnapshot, NOW, session } from './fixtures'

const need = { status: { bucket: 'needs-you', reason: 'Asked you a question', since: NOW - 60_000, isObserved: true } } as Partial<SessionView>
const old = NOW - 3 * 86_400_000

function snapshot() {
  return normalizeSnapshot(
    buildSnapshot([
      session('local_here', { title: 'Here', projectId: 'c:\\repo\\here', worktreeId: 'c:\\repo\\here' }),
      session('local_pinned', { title: 'Pinned long ago', projectId: 'c:\\repo\\there', worktreeId: 'c:\\repo\\there', lifecycle: 'completed', lastActivityAt: old, finishedAt: old }),
      session('local_asks', { title: 'Asks elsewhere', projectId: 'c:\\repo\\there', worktreeId: 'c:\\repo\\there', lifecycle: 'waiting-user', attention: 'question', attentionText: 'Asked you a question', ...need }),
      session('local_quiet', { title: 'Quiet elsewhere', projectId: 'c:\\repo\\there', worktreeId: 'c:\\repo\\there' }),
    ]),
  )
}

const keys = (list: { key: string }[]) => list.map(s => s.key).sort()
const sessionNodes = (view: ReturnType<typeof visibleOf>) => view.nodes.filter(n => n.kind === 'session').map(n => n.ref).sort()

test('pin: a pinned session is never hidden by the time window, the completed filter, the project or the search; Hide still applies; isPinned on the session', () => {
  const snap = snapshot()
  const filters = { ...DEFAULT_FILTERS, time: '24h' as const, showCompleted: false, project: 'c:\\repo\\here', search: 'here' }
  const view = visibleOf(snap, filters, DEFAULT_SETTINGS, [], NOW, { pinned: ['local_pinned'] })
  expect(keys(view.sessions)).toEqual(['local_here', 'local_pinned'])
  expect(sessionNodes(view)).toEqual(['local_here', 'local_pinned'])
  expect(view.sessions.map(x => [x.key, x.isPinned ?? false])).toEqual([['local_here', false], ['local_pinned', true]])
  expect(view.pinned.map(x => x.isPinned)).toEqual([true])
  const hidden = visibleOf(snap, filters, DEFAULT_SETTINGS, [], NOW, { pinned: ['local_pinned'], hidden: { local_pinned: old } })
  expect(keys(hidden.sessions)).toEqual(['local_here'])
  expect(hidden.hiddenCount).toBe(1)
  expect(visibleOf(snap, DEFAULT_FILTERS, DEFAULT_SETTINGS, [], NOW).sessions.some(x => x.isPinned)).toBe(false)
})

test('project filter: with keepNeedsYouInProject, a session that needs you stays in view from another project; quiet ones do not; without it, today’s rule', () => {
  const snap = snapshot()
  const filters = { ...DEFAULT_FILTERS, project: 'c:\\repo\\here' }
  expect(keys(visibleOf(snap, filters, DEFAULT_SETTINGS, [], NOW).sessions)).toEqual(['local_here'])
  const kept = visibleOf(snap, filters, DEFAULT_SETTINGS, [], NOW, { keepNeedsYouInProject: true })
  expect(keys(kept.sessions)).toEqual(['local_asks', 'local_here'])
  expect(sessionNodes(kept)).toEqual(['local_asks', 'local_here'])
  expect(keys(visibleOf(snap, { ...filters, search: 'nothing matches' }, DEFAULT_SETTINGS, [], NOW, { keepNeedsYouInProject: true }).sessions)).toEqual([])
})

test('2.1.5: the map shows no diamond for a project’s main checkout, only for its other worktrees', () => {
  const snap = normalizeSnapshot(
    buildSnapshot([
      session('local_main', { projectId: 'c:\\repo\\app', worktreeId: 'c:\\repo\\app' }),
      session('local_wt', { projectId: 'c:\\repo\\app', worktreeId: 'c:\\repo\\app-wt' }),
    ]),
  )
  const view = visibleOf(snap, DEFAULT_FILTERS, DEFAULT_SETTINGS, [], NOW)
  expect(view.nodes.filter(n => n.kind === 'worktree').map(n => n.ref)).toEqual(['c:\\repo\\app-wt'])
  expect(view.edges.some(e => e.to === 'w:c:\\repo\\app')).toBe(false)
})
