import { expect, test } from 'claude-code/testing'

import { convoHome, escapeAction, keyAction, viewOf } from '../shared/popout.js'

test('2.2: l shows the Conversation view and g the map; Shift or Ctrl with them do nothing', () => {
  expect(keyAction({ key: 'l' })).toBe('view-conversation')
  expect(keyAction({ key: 'g' })).toBe('view-map')
  expect(keyAction({ key: 'l', ctrlKey: true })).toBe(null)
})

test("2.2: the window's view is the map unless it chose the Conversation view; the old List choice carries over", () => {
  expect(viewOf('conversation')).toBe('conversation')
  expect(viewOf('list')).toBe('conversation')
  expect(viewOf('map')).toBe('map')
  expect(viewOf(null)).toBe('map')
  expect(viewOf('graph')).toBe('map')
})

const rows = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}` }))

test('2.2: with nothing open, the centre counts the sessions that need you and lists the first five', () => {
  const home = convoHome([{ key: 'needs-you', rows: rows('n', 7) }, { key: 'working', rows: rows('w', 2) }])
  expect(home.heading).toBe('7 sessions need you')
  expect(home.top.map(r => r.key)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4'])
  expect(home.more).toBe(2)
  expect(convoHome([{ key: 'needs-you', rows: rows('n', 1) }]).heading).toBe('1 session needs you')
})

test('2.2: with nothing needing you, the centre says so, or that there are no sessions', () => {
  const quiet = convoHome([{ key: 'working', rows: rows('w', 3) }])
  expect(quiet.heading).toBe('Nothing needs you')
  expect(quiet.top).toEqual([])
  expect(quiet.more).toBe(0)
  expect(convoHome([]).heading).toBe('No sessions')
})

test('2.2: Esc folds details shown over the conversation before it closes the session', () => {
  const base = { inPanelField: false, inSearch: false, hasQuery: false, railOpen: false, cardShown: false, panelOpen: true }
  expect(escapeAction({ ...base, detailsShown: true })).toEqual({ closeDetails: true })
  expect(escapeAction({ ...base, detailsShown: true, inPanelField: true })).toEqual({ blurField: true })
  expect(escapeAction(base)).toEqual({ closePanel: true, hideCard: false })
})
