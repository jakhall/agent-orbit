import { expect, test } from 'claude-code/testing'

import { queueGroups, snapshotChanged, withLayout } from '../shared/popout.js'
import { lightThemeCss, paletteVars } from '../shared/render.js'
import { buildSnapshot, NOW, session } from './fixtures'

const st = (bucket: string, since: number | null, reason = 'r') => ({ bucket, reason, since, isObserved: true })

test('the rail puts Needs you first (longest waiting first), then Failed, Ready for review, Working and Idle; empty groups are left out', () => {
  const sessions = [
    session('local_w1', { status: st('working', NOW - 10_000), lastActivityAt: NOW - 5_000 } as never),
    session('local_n1', { status: st('needs-you', NOW - 60_000) } as never),
    session('local_n2', { status: st('needs-you', NOW - 600_000) } as never),
    session('local_r1', { status: st('review', NOW - 120_000) } as never),
    session('local_r2', { status: st('review', NOW - 30_000) } as never),
    session('local_w2', { status: st('working', NOW - 10_000), lastActivityAt: NOW - 1_000 } as never),
    session('local_i1', { status: st('idle', NOW - 900_000), lastActivityAt: NOW - 900_000 } as never),
  ]
  const groups = queueGroups(sessions as never, NOW)
  expect(groups.map(g => [g.key, g.label, g.rows.map(s => s.key)])).toEqual([
    ['needs-you', 'Needs you', ['local_n2', 'local_n1']],
    ['review', 'Ready for review', ['local_r2', 'local_r1']],
    ['working', 'Working', ['local_w2', 'local_w1']],
    ['idle', 'Idle', ['local_i1']],
  ])
  expect(queueGroups([session('local_x') as never], NOW).map(g => g.key)).toEqual(['idle'])
})

test('a new snapshot is fetched when the server says seq or bootId moved, not for prefs or approvals alone', () => {
  const now = { seq: 4, bootId: 'aaaaaaaaaaaaaaaa', checkedAt: 1 }
  expect(snapshotChanged(null, now)).toBe(true)
  expect(snapshotChanged(now, { ...now, checkedAt: 99 })).toBe(false)
  expect(snapshotChanged(now, { ...now, seq: 5 })).toBe(true)
  expect(snapshotChanged(now, { ...now, bootId: 'bbbbbbbbbbbbbbbb', seq: 4 })).toBe(true)
})

test('a schema 2 snapshot gets its graph from the shared layout, the same every time for the same input', () => {
  const snap = buildSnapshot([session('local_a'), session('local_b')], [])
  const v2 = { projects: snap.projects, worktrees: snap.worktrees, sessions: snap.sessions, agents: snap.agents }
  const a = withLayout(v2, {})
  const b = withLayout(v2, {})
  expect(a.graph.nodes.map(n => n.id)).toContain('s:local_a')
  expect(JSON.stringify(a.graph)).toBe(JSON.stringify(b.graph))
})

test('palette colours in markup become CSS variables so the map follows the theme; a repeated value keeps its first name', () => {
  expect(paletteVars('<circle fill="#0B0C0E" stroke="#6c93e8"/>')).toBe('<circle fill="var(--bg)" stroke="var(--accent)"/>')
  expect(paletteVars('<rect fill="#1B1D21"/>')).toBe('<rect fill="var(--raised)"/>')
  expect(paletteVars('fill="#123456"')).toBe('fill="#123456"')
})

test('the light theme is one CSS block for the system setting and the window override', () => {
  const css = lightThemeCss()
  expect(css).toContain('@media (prefers-color-scheme: light)')
  expect(css).toContain(":root:not([data-theme='dark'])")
  expect(css).toContain(":root[data-theme='light']")
  expect(css).toContain('--bg:#F7F8FA')
  expect(css).toContain('--on-accent:#FFFFFF')
})
