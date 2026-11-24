import { expect, test } from 'claude-code/testing'

import { attentionPost } from '../shared/popout.js'
import type { SessionView } from '../types'

const NOW = 1_700_000_000_000
const WINDOW = '0123456789abcdef'

test('switch E-110: the attention post carries the open session, and a changed selection is posted even while not attentive', () => {
  expect(attentionPost(true, WINDOW, null, 'local_a')).toEqual({ attentive: true, windowId: WINDOW, selected: 'local_a' })
  expect(attentionPost(true, WINDOW, null)).toEqual({ attentive: true, windowId: WINDOW, selected: null })
  const idle = { attentive: false, windowId: WINDOW, selected: 'local_a' }
  expect(attentionPost(false, WINDOW, idle, 'local_a')).toBe(null)
  expect(attentionPost(false, WINDOW, idle, 'local_b')).toEqual({ attentive: false, windowId: WINDOW, selected: 'local_b' })
  expect(attentionPost(false, WINDOW, idle, null)).toEqual({ attentive: false, windowId: WINDOW, selected: null })
})

const session = (patch: Partial<SessionView>): SessionView => ({ key: 'local_a', lifecycle: 'idle', stateSince: NOW - 60_000, finishedAt: NOW - 60_000, lastFocusedAt: null, ...patch }) as SessionView
