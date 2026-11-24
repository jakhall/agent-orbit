import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const chat = readFileSync(new URL('../../companion/inbox/chat.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../companion/inbox/chat-late.css', import.meta.url), 'utf8')

test('2.1.6: a question Orbit did not take says why and offers Open in Claude', () => {
  assert.doesNotMatch(chat, /answer it in Claude \(o\)/)
  assert.match(chat, /if \(quote\?\.who === 'question'\) return questionElsewhere\(s\)/)
  const body = /function questionElsewhere\(s\) \{([\s\S]*?)\n\}/.exec(chat)?.[1] ?? ''
  assert.match(body, /This question is in Claude\./)
  assert.match(body, /only while its window is in front/)
  assert.match(body, /s\.canOpen \?/)
  assert.match(body, /hooks\.openSession\(s\)/)
  assert.match(body, /'aria-keyshortcuts': 'o'/)
  assert.match(css, /\.q-elsewhere \.reply-label \{/)
})
