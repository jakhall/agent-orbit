import { expect, test } from 'claude-code/testing'

import { keyAction, PALETTE_SKILLS_MAX, paletteResults } from '../shared/popout.js'

const ACTIONS = [
  { id: 'new-session', label: 'New session' },
  { id: 'settings', label: 'Settings' },
  { id: 'fit', label: 'Fit the map' },
  { id: 'snooze-hour', label: 'Snooze 1 hour' },
]
const SESSIONS = [{ key: 'cli:a', title: 'billing (terminal)' }, { key: 'cli:b', title: 'new parser' }]

test('C9: the palette lists sessions first and every action after them when nothing is typed', () => {
  const items = paletteResults('', SESSIONS, ACTIONS)
  expect(items.map(i => (i.kind === 'session' ? i.session.key : i.action.id))).toEqual(['cli:a', 'cli:b', 'new-session', 'settings', 'fit', 'snooze-hour'])
})

test('C9: an action whose words start with the query comes before sessions; others follow them; non-matching actions drop out', () => {
  const items = paletteResults('new', SESSIONS.filter(s => s.title.includes('new')), ACTIONS)
  expect(items.map(i => (i.kind === 'session' ? i.session.key : i.action.id))).toEqual(['new-session', 'cli:b'])
  expect(paletteResults('SET', [], ACTIONS).map(i => (i.kind === 'action' ? i.action.id : null))).toEqual(['settings'])
  expect(paletteResults('map', [], ACTIONS).map(i => (i.kind === 'action' ? i.action.id : null))).toEqual(['fit'])
  expect(paletteResults('bill', SESSIONS.slice(0, 1), ACTIONS).map(i => i.kind)).toEqual(['session'])
  expect(paletteResults('ett', [], ACTIONS)).toEqual([])
})

test('C9: c opens New session on the page too, and Ctrl+K is the palette, not a page key', () => {
  expect(keyAction({ key: 'c' })).toBe('new-session')
  expect(keyAction({ key: 'k', ctrlKey: true })).toBe(null)
})

test('C9 review #1-2: a session action matches only on its verb, ranks after sessions, and carries the session it was built for', () => {
  const actions: { id: string, label: string, verb?: string, key?: string }[] = [...ACTIONS.filter(a => a.id !== 'snooze-hour'), { id: 'done', label: 'Done: billing (terminal)', verb: 'Done', key: 'cli:a' }, { id: 'snooze-hour', label: 'Snooze 1 hour: billing (terminal)', verb: 'Snooze 1 hour', key: 'cli:a' }]
  const ids = (q: string, sessions = SESSIONS) => paletteResults(q, sessions, actions).map(i => (i.kind === 'session' ? i.session.key : i.action.id))
  expect(ids('bill', SESSIONS.slice(0, 1))).toEqual(['cli:a'])
  expect(ids('done', [])).toEqual(['done'])
  expect(ids('sn', [])).toEqual(['snooze-hour'])
  expect(ids('', SESSIONS)).toEqual(['cli:a', 'cli:b', 'new-session', 'settings', 'fit', 'done', 'snooze-hour'])
  const done = paletteResults('done', [], actions)[0]
  expect(done?.kind === 'action' ? done.action.key : null).toBe('cli:a')
})

test('shelf skills join the palette only for a query, after the session actions, by word starts and capped', () => {
  const skill = (n: number, label: string) => ({ id: `skill:s${n}`, label: `Apply ${label}: billing`, verb: `Apply ${label}`, key: 'cli:a', search: `apply ${label} /s${n} toolbox`.toLowerCase() })
  const actions = [...ACTIONS, { id: 'done', label: 'Done: billing', verb: 'Done', key: 'cli:a' }, skill(1, 'Code review'), skill(2, 'Grill me')]
  expect(paletteResults('', SESSIONS, actions).some(i => i.kind === 'action' && i.action.id.startsWith('skill:'))).toBe(false)
  expect(paletteResults('code rev', [], actions).map(i => (i.kind === 'action' ? i.action.id : null))).toEqual(['skill:s1'])
  expect(paletteResults('tool', [], actions).map(i => (i.kind === 'action' ? i.action.id : null))).toEqual(['skill:s1', 'skill:s2'])
  expect(paletteResults('s1', [], actions).map(i => (i.kind === 'action' ? i.action.id : null))).toEqual(['skill:s1'])
  expect(paletteResults('d', [], actions).map(i => (i.kind === 'action' ? i.action.id : null))).toEqual(['done'])
  const many = Array.from({ length: PALETTE_SKILLS_MAX + 3 }, (_, n) => skill(n, `Skill ${n}`))
  expect(paletteResults('apply', [], many)).toHaveLength(PALETTE_SKILLS_MAX)
})
