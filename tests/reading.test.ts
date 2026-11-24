import { expect, test } from 'claude-code/testing'

import { APPROVAL_ARM_MS } from '../shared/approvals.js'
import { errorsText, linkParts, questionSendArmed, rowSecondLine } from '../shared/popout.js'

const NOW = new Date(2026, 10, 13, 14, 30).getTime()

test('C7: linkParts finds markdown links and bare http(s) URLs, with their host', () => {
  expect(linkParts('See [the docs](https://example.com/a/b?c=1) now.')).toEqual([
    { type: 'text', text: 'See ' },
    { type: 'link', text: 'the docs', href: 'https://example.com/a/b?c=1', host: 'example.com' },
    { type: 'text', text: ' now.' },
  ])
  expect(linkParts('Open http://localhost:3000/x.')).toEqual([
    { type: 'text', text: 'Open ' },
    { type: 'link', text: 'http://localhost:3000/x', href: 'http://localhost:3000/x', host: 'localhost:3000' },
    { type: 'text', text: '.' },
  ])
  expect(linkParts('(see https://a.example.org/p)')).toEqual([
    { type: 'text', text: '(see ' },
    { type: 'link', text: 'https://a.example.org/p', href: 'https://a.example.org/p', host: 'a.example.org' },
    { type: 'text', text: ')' },
  ])
  expect(linkParts('a https://en.wikipedia.org/wiki/Foo_(bar) b')[1]).toEqual({ type: 'link', text: 'https://en.wikipedia.org/wiki/Foo_(bar)', href: 'https://en.wikipedia.org/wiki/Foo_(bar)', host: 'en.wikipedia.org' })
})

test('C7: linkParts keeps anything that is not http or https as plain text', () => {
  expect(linkParts('[x](javascript:alert(1)) and file:///c:/a and [y](mailto:a@b.c)')).toEqual([{ type: 'text', text: '[x](javascript:alert(1)) and file:///c:/a and [y](mailto:a@b.c)' }])
  expect(linkParts('no links here')).toEqual([{ type: 'text', text: 'no links here' }])
  expect(linkParts('')).toEqual([])
  expect(linkParts('https://')).toEqual([{ type: 'text', text: 'https://' }])
})

test('C7: errorsText words the E-29 trace, and is null without errors', () => {
  expect(errorsText(undefined, NOW)).toBe(null)
  expect(errorsText({ count: 0, lastAt: NOW, where: 'tick', kind: 'Error' }, NOW)).toBe(null)
  expect(errorsText({ count: 1, lastAt: NOW - 5 * 60_000, where: 'publish', kind: 'EBUSY' }, NOW)).toBe('1 error, last 5m ago in publish (EBUSY)')
  expect(errorsText({ count: 12, lastAt: NOW - 10_000, where: 'render', kind: 'TypeError' }, NOW)).toBe('12 errors, last just now in render (TypeError)')
})

test('C7: the queue row second line is the ask, else the last report, on one line', () => {
  expect(rowSecondLine({ lastReport: { text: 'Done with the parser.', ask: 'Merge it?' } }, 'Needs you · Merge it?')).toBe('Done with the parser.')
  expect(rowSecondLine({ lastReport: { text: 'Done.\n\nAll   green.', ask: 'Ship?' } }, 'Idle')).toBe('Ship?')
  expect(rowSecondLine({ lastReport: { text: 'Line one\nline two' } }, 'Idle')).toBe('Line one line two')
  expect(rowSecondLine({ lastReport: null }, 'Idle')).toBe(null)
  expect(rowSecondLine({ lastReport: { text: 'x'.repeat(300) } }, 'Idle')?.length).toBe(140)
})

test('S1: a question card’s Send arms only APPROVAL_ARM_MS after the panel holding it shows, so no key sequence sends at once', () => {
  const shown = 1_000_000
  expect(questionSendArmed(null, shown)).toBe(false)
  expect(questionSendArmed(shown, shown)).toBe(false)
  expect(questionSendArmed(shown, shown + APPROVAL_ARM_MS - 1)).toBe(false)
  expect(questionSendArmed(shown, shown + APPROVAL_ARM_MS)).toBe(true)
  expect(APPROVAL_ARM_MS).toBeGreaterThanOrEqual(1_000)
})
