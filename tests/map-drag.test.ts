import { expect, test } from 'claude-code/testing'

import { descendantsOf } from '../shared/filters.js'
import { escapeAction, mapClickAction } from '../shared/popout.js'
import { offsetFor } from '../shared/render.js'

const nodes = [
  { id: 'p:a', parent: null, x: 100, y: 50 },
  { id: 's:1', parent: 'p:a', x: 178, y: 50 },
  { id: 'a:1', parent: 's:1', x: 200, y: 70 },
  { id: 'p:b', parent: null, x: 400, y: 50 },
]

test('2.1.1: a dragged node is saved as 1.15 saved it: a hub at its place, anything else as an offset from its parent', () => {
  expect(offsetFor(nodes[0] as never, 130, 90, nodes as never)).toEqual({ dx: 130, dy: 90 })
  expect(offsetFor(nodes[1] as never, 190, 30, nodes as never)).toEqual({ dx: 90, dy: -20 })
  expect(offsetFor(nodes[2] as never, 210, 60, nodes as never)).toEqual({ dx: 32, dy: 10 })
})

test('2.1.1: dragging a hub moves its whole cluster; dragging a session moves it with its own children only', () => {
  expect([...descendantsOf('p:a', nodes as never)].sort()).toEqual(['a:1', 'p:a', 's:1'])
  expect([...descendantsOf('s:1', nodes as never)].sort()).toEqual(['a:1', 's:1'])
})

test('2.1.1: a click on a session selects it, a click on empty map deselects and closes the panel, a click on a hub keeps things as they are', () => {
  expect(mapClickAction('s:1')).toBe('select')
  expect(mapClickAction(null)).toBe('deselect')
  expect(mapClickAction('p:a')).toBe('project')
  expect(mapClickAction('w:a')).toBe('none')
})

test('2.1.7: a click on a sub-agent opens its own panel', () => {
  expect(mapClickAction('a:s1/abc')).toBe('agent')
})

test("2.1.1: Esc closes the open panel even while a hover card shows; a field you're typing in, the search and the queue overlay still come first", () => {
  const base = { inPanelField: false, inSearch: false, hasQuery: false, railOpen: false, cardShown: false, panelOpen: false }
  expect(escapeAction({ ...base, panelOpen: true, cardShown: true })).toEqual({ closePanel: true, hideCard: true })
  expect(escapeAction({ ...base, panelOpen: true })).toEqual({ closePanel: true, hideCard: false })
  expect(escapeAction({ ...base, panelOpen: true, inPanelField: true })).toEqual({ blurField: true })
  expect(escapeAction({ ...base, panelOpen: true, inSearch: true })).toEqual({ clearSearch: true })
  expect(escapeAction({ ...base, panelOpen: true, railOpen: true })).toEqual({ closeRail: true })
  expect(escapeAction({ ...base, cardShown: true })).toEqual({ hideCard: true })
  expect(escapeAction({ ...base, hasQuery: true })).toEqual({ clearSearch: true })
  expect(escapeAction({ ...base, panelOpen: true, hasQuery: true })).toEqual({ closePanel: true, hideCard: false })
  expect(escapeAction(base)).toEqual({})
  expect(escapeAction({ ...base, projectFocused: true })).toEqual({ clearFocus: true })
  expect(escapeAction({ ...base, projectFocused: true, cardShown: true })).toEqual({ hideCard: true })
  expect(escapeAction({ ...base, projectFocused: true, panelOpen: true })).toEqual({ closePanel: true, hideCard: false })
})
