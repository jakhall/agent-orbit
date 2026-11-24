import { expect, test } from 'claude-code/testing'

import { browserUrl, checkNewSession, handOffLink, newSessionLink, normalizeFolder, openSessionLink, recentFolders } from '../shared/links.js'
import { buildSnapshot, NOW, session } from './fixtures'

test('only http and https addresses go to the default browser, normalised so nothing in them reads as a command', () => {
  expect(browserUrl('https://github.com/a/b/pull/1')).toBe('https://github.com/a/b/pull/1')
  expect(browserUrl('http://example.com/a b?q="x"&y=1')).toBe('http://example.com/a%20b?q=%22x%22&y=1')
  expect(browserUrl('HTTPS://Example.com')).toBe('https://example.com/')
  expect(browserUrl('javascript:alert(1)')).toBeNull()
  expect(browserUrl('file:///C:/Windows/System32/calc.exe')).toBeNull()
  expect(browserUrl('claude://claude.ai/epitaxy/local_1')).toBeNull()
  expect(browserUrl('C:\\Windows\\notepad.exe')).toBeNull()
  expect(browserUrl('not a url')).toBeNull()
  expect(browserUrl('')).toBeNull()
  expect(browserUrl(42)).toBeNull()
  expect(browserUrl(`https://example.com/${'a'.repeat(5000)}`)).toBeNull()
})

test('folders for a new session must be absolute Windows paths', () => {
  expect(normalizeFolder('C:\\repos\\app\\')).toBe('C:\\repos\\app')
  expect(normalizeFolder('  "C:/repos/app"  ')).toBe('C:\\repos\\app')
  expect(normalizeFolder('C:\\')).toBe('C:\\')
  expect(normalizeFolder('\\\\server\\share\\x')).toBeNull()
  expect(normalizeFolder('C:\\repos\\\\app')).toBe('C:\\repos\\app')
  expect(normalizeFolder('repos\\app')).toBeNull()
  expect(normalizeFolder('C:\\repos\\..\\Windows')).toBeNull()
  expect(normalizeFolder('C:\\a:b')).toBeNull()
  expect(normalizeFolder('C:\\a\nb')).toBeNull()
  expect(normalizeFolder('')).toBeNull()
})

test('the new-session link is the documented claude://code/new form, URL-encoded', () => {
  expect(newSessionLink('C:\\repo app', '')).toBe('claude://code/new?folder=C%3A%5Crepo%20app')
  expect(newSessionLink('C:\\r', ' Fix the login & tests ')).toBe('claude://code/new?folder=C%3A%5Cr&q=Fix%20the%20login%20%26%20tests')
  expect(checkNewSession('C:\\r', 'x'.repeat(4001))).toEqual({ ok: false, error: 'Keep the first prompt under 4000 characters.' })
  expect(checkNewSession('C:\\r', '漢'.repeat(3999)).ok).toBe(false)
  expect(checkNewSession('\\\\nas\\code', '').ok).toBe(false)
  expect(checkNewSession('C:/r', 'hi')).toEqual({ ok: true, folder: 'C:\\r', link: 'claude://code/new?folder=C%3A%5Cr&q=hi' })
})

test('recent folders list project roots and other checkouts, newest first, without duplicates', () => {
  const snapshot = buildSnapshot([
    session('local_00000001-0000-4000-8000-000000000001', { projectId: 'c:\\repo\\old', worktreeId: 'c:\\repo\\old', lastActivityAt: NOW - 9_000_000 }),
    session('local_00000001-0000-4000-8000-000000000002', { projectId: 'c:\\repo\\app', worktreeId: 'c:\\repo\\app', lastActivityAt: NOW - 60_000 }),
    session('local_00000001-0000-4000-8000-000000000003', { projectId: 'c:\\repo\\app', worktreeId: 'c:\\repo\\app\\.claude\\worktrees\\wt1', branch: 'feature', lastActivityAt: NOW - 1_000 }),
    session('cli:x', { projectId: 'Unknown folder', worktreeId: null }),
  ])
  const folders = recentFolders(snapshot)
  expect(folders.map(f => f.path)).toEqual(['c:\\repo\\app\\.claude\\worktrees\\wt1', 'c:\\repo\\app', 'c:\\repo\\old'])
  expect(folders[0]?.label).toBe('app (feature)')
})

test('the window opens only an Open or New session link the server handed back', () => {
  const open = openSessionLink('local_0a1b2c3d-0000-4000-8000-000000000001')
  expect(handOffLink({ error: 'x', handOff: open })).toBe(open)
  expect(handOffLink({ handOff: 'claude://code/new?folder=C%3A%5Crepo&q=hi' })).toBe('claude://code/new?folder=C%3A%5Crepo&q=hi')
  expect([handOffLink(null), handOffLink({ error: 'x' }), handOffLink({ handOff: 42 }), handOffLink({ handOff: 'https://example.com' }), handOffLink({ handOff: 'claude://claude.ai/epitaxy/../x' }), handOffLink({ handOff: 'claude://claude.ai/settings' })]).toEqual([null, null, null, null, null, null])
})
