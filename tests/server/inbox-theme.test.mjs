import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { lightThemeCss } from '../../shared/render.js'

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')

test('C8: /inbox applies the light theme and a stored choice before its first paint', () => {
  const html = read('../../companion/inbox.html')
  const head = html.slice(0, html.indexOf('</head>'))
  const firstAsset = Math.min(...['<link rel="stylesheet"', '<script type="module"'].map(tag => head.indexOf(tag)).filter(i => i >= 0))
  const early = head.slice(0, firstAsset)
  assert.ok(early.includes('<meta name="color-scheme" content="dark light" />'), 'the color-scheme meta comes first')
  assert.ok(early.includes(`<style id="theme-light">${lightThemeCss()}</style>`), 'the inline light theme equals lightThemeCss(): run node tools/sync-light-theme.mjs')
  assert.ok(early.includes('<script src="/inbox/theme.js"></script>'), 'a classic, blocking theme script runs before the stylesheets')
  const script = read('../../companion/inbox/theme.js')
  assert.equal(script.includes('import '), false, 'theme.js is a classic script')
  assert.ok(script.includes("'orbit.theme'"), 'theme.js reads the stored choice')
})

test('C8 review #1: placeholders take the muted token, never the browser default grey', () => {
  const base = read('../../companion/inbox/base.css')
  assert.match(base, /::placeholder\s*\{[^}]*color:\s*var\(--muted\)[^}]*opacity:\s*1/, 'base.css sets ::placeholder to var(--muted) at full opacity')
})
