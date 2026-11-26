import { expect, test } from 'claude-code/testing'

import type { ConversationRow } from '../types'
import { CONVERSATION_ROWS, fileIdOf, offsetParam, pageRows, readConversation, textLines, transcriptLines } from '../shared/conversation.js'
import { MARKDOWN_MAX_CHARS, MARKDOWN_TABLE_COLUMNS, MARKDOWN_TABLE_ROWS, parseInline, parseMarkdown, tableCells } from '../shared/markdown.js'
import { BUBBLE_KEEP_MS, CHAT_MIN_PX, chatBubble, isAwaitingAgent, chatMarks, answeredQuestions, chooseOption, composerHint, composerLabel, canWake, asleepCardText, dayLabel, DETAILS_MIN_PX, emptyQuestionDraft, isRowAfter, mayFocusNewCard, liveFrom, mergeLive, mergeOlder, nextStepLast, withoutOpenQuestion, PIN_COVER_PX, PIN_VISIBLE_PX, pinnedPrompt, promptCount, questionHint, taskList, questionPost, questionReview, readOnlyShort, tabAfterChoice, replyQuote, TURN_GAP_MS, type Send } from '../shared/popout.js'
import { checkQuestionAnswer } from '../shared/approvals.js'
import { steerContext } from '../shared/inbox.js'
import { commandHead } from '../shared/redact.js'
import { NOW, rowsOfTranscript } from './fixtures'

const at = (s: number) => new Date(NOW + s * 1000).toISOString()
const line = (value: unknown) => JSON.stringify(value)
const user = (content: unknown, s: number) => line({ type: 'user', timestamp: at(s), message: { role: 'user', content } })
const assistant = (content: unknown[], s: number) => line({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', content } })
const said = (text: string, s: number) => assistant([{ type: 'text', text }], s)
const encoder = new TextEncoder()

function transcript(turns: number): { text: string, bytes: Uint8Array } {
  const lines: string[] = []
  for (let i = 1; i <= turns; i += 1) {
    lines.push(user(`Prompt ${i} — ünï`, i * 10))
    lines.push(said(`First part ${i}`, i * 10 + 1))
    lines.push(said(`Second part ${i} ✓`, i * 10 + 2))
    lines.push(assistant([{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `C:\\repo\\f${i}.ts` } }], i * 10 + 3))
    lines.push(user([{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(i % 3 === 0 ? 900 : 40) }], i * 10 + 4))
  }
  const text = `${lines.join('\n')}\n`
  return { text, bytes: encoder.encode(text) }
}

const reader = (bytes: Uint8Array) => (begin: number, end: number) => bytes.subarray(begin, end)
const row = (who: ConversationRow['who'], text: string, o: number, extra: Partial<ConversationRow> = {}): ConversationRow => ({ who, at: NOW + o, text, o, ...extra })

test('markdown: fenced code, paragraphs, lists, headings and inline code, bold and italic; everything else stays literal', () => {
  const blocks = parseMarkdown(['## Plan ##', 'Run `npm test` and **then** commit, *carefully*.', 'A second line.', '', '- one', '  - nested', '    deeper', '1. first', '3) second', '', '```ts', 'const a = `x` <b>', '```', '<script>alert(1)</script> [link](https://example.com) ![img](x.png)', '> quote'].join('\n'))
  expect(blocks.map(b => b.type)).toEqual(['heading', 'para', 'list', 'list', 'code', 'para'])
  expect(blocks[0]).toEqual({ type: 'heading', inline: [{ type: 'text', text: 'Plan' }] })
  expect(blocks[1]).toEqual({
    type: 'para',
    inline: [
      { type: 'text', text: 'Run ' },
      { type: 'code', text: 'npm test' },
      { type: 'text', text: ' and ' },
      { type: 'bold', text: 'then' },
      { type: 'text', text: ' commit, ' },
      { type: 'italic', text: 'carefully' },
      { type: 'text', text: '.\nA second line.' },
    ],
  })
  expect(blocks[2]).toEqual({ type: 'list', ordered: false, start: 1, items: [{ inline: [{ type: 'text', text: 'one' }], indent: 0 }, { inline: [{ type: 'text', text: 'nested deeper' }], indent: 1 }] })
  expect(blocks[3]).toEqual({ type: 'list', ordered: true, start: 1, items: [{ inline: [{ type: 'text', text: 'first' }], indent: 0 }, { inline: [{ type: 'text', text: 'second' }], indent: 0 }] })
  expect(blocks[4]).toEqual({ type: 'code', lang: 'ts', text: 'const a = `x` <b>' })
  expect(blocks[5]).toEqual({ type: 'para', inline: [{ type: 'text', text: '<script>alert(1)</script> [link](https://example.com) ![img](x.png)\n> quote' }] })
})

test('markdown: an unclosed fence runs to the end, unclosed inline marks stay text, and long input is cut and parsed in linear time', () => {
  expect(parseMarkdown('Before\n```\ncode **not bold**\nstill code')).toEqual([
    { type: 'para', inline: [{ type: 'text', text: 'Before' }] },
    { type: 'code', lang: '', text: 'code **not bold**\nstill code' },
  ])
  expect(parseInline('a ` b ** c * d')).toEqual([{ type: 'text', text: 'a ` b ** c * d' }])
  expect(parseInline('2 * 3 * 4 and snake_case_name')).toEqual([{ type: 'text', text: '2 * 3 * 4 and snake_case_name' }])
  expect(parseInline('``a `b` c``')).toEqual([{ type: 'code', text: 'a `b` c' }])
  expect(parseMarkdown('').length).toBe(0)
  const long = parseMarkdown('y'.repeat(MARKDOWN_MAX_CHARS + 500))
  expect(long[0]?.type === 'para' && long[0].inline[0]?.text.length).toBe(MARKDOWN_MAX_CHARS)
  const started = Date.now()
  for (const hostile of ['`a'.repeat(4000), '*'.repeat(8000), '** a'.repeat(2000), '# a' + ' '.repeat(7990) + 'b', '- x\n'.repeat(2000)]) parseMarkdown(hostile)
  expect(Date.now() - started).toBeLessThan(1000)
})

test('transcript lines: byte offsets count UTF-8, a window inside a line drops it up to the next line, and a window that is all one line keeps its start', () => {
  const text = `${user('héllo ✓', 1)}\n${said('ok', 2)}\n`
  const lines = textLines(text)
  expect(lines[1]?.o).toBe(encoder.encode(`${user('héllo ✓', 1)}\n`).length)
  const bytes = encoder.encode(text)
  const whole = transcriptLines(bytes, 0, true)
  expect(whole.lines.map(l => l.o)).toEqual([0, lines[1]?.o])
  expect(whole.start).toBe(0)
  const inside = transcriptLines(bytes.subarray(5), 5, false)
  expect(inside.lines.map(l => [l.o, l.text])).toEqual([[lines[1]?.o, said('ok', 2)]])
  expect(inside.start).toBe(lines[1]?.o)
  const partOfOne = transcriptLines(bytes.subarray(5, 20), 5, false)
  expect(partOfOne).toEqual({ lines: [], start: 5 })
  const endsAtNewline = transcriptLines(bytes.subarray(5, (lines[1]?.o ?? 0)), 5, false)
  expect(endsAtNewline).toEqual({ lines: [], start: 5 })
})

test('rows carry the offset of their first line; a window that may cut into a reply or tool run drops that first row, never a prompt', () => {
  const { text } = transcript(2)
  const lines = textLines(text)
  const { rows } = rowsOfTranscript(text)
  expect(rows.map(r => [r.who, r.o])).toEqual([
    ['you', lines[0]?.o],
    ['claude', lines[1]?.o],
    ['tools', lines[3]?.o],
    ['you', lines[5]?.o],
    ['claude', lines[6]?.o],
    ['tools', lines[8]?.o],
  ])
  expect(rows[1]?.text).toBe('First part 1\n\nSecond part 1 ✓')
  const fromReply = lines.slice(2)
  const cut = pageRows(fromReply, fromReply[0]?.o ?? 0, { isCut: true, limit: null })
  expect(cut.rows[0]?.who).toBe('tools')
  expect(cut.rows.length).toBe(4)
  expect(pageRows(fromReply.slice(1), fromReply[1]?.o ?? 0, { isCut: true, limit: null }).rows[0]?.who).toBe('you')
  const fromPrompt = lines.slice(5)
  const kept = pageRows(fromPrompt, fromPrompt[0]?.o ?? 0, { isCut: true, limit: 2 })
  expect(kept.rows.map(r => r.who)).toEqual(['claude', 'tools'])
  expect(kept.start).toBe(kept.rows[0]?.o)
  const none = pageRows(fromPrompt, fromPrompt[0]?.o ?? 0, { isCut: true, limit: null })
  expect(none.start).toBe(fromPrompt[0]?.o)
})

test('paging back from the tail with small chunks rebuilds every row once, in order, across chunk edges', async () => {
  const { text, bytes } = transcript(40)
  const all = textLines(text)
  const full = pageRows(all, 0, { isCut: false, limit: null }).rows
  expect(full.length).toBe(120)
  const sizes = { first: 256, max: 4096 }
  const tail = await readConversation(reader(bytes), { mode: 'tail', size: bytes.length }, sizes)
  expect(tail.size).toBe(bytes.length)
  expect(tail.isStart).toBe(false)
  let held = tail.rows
  let cursor = tail.start
  let isStart = tail.isStart
  for (let i = 0; i < 100 && !isStart; i += 1) {
    const page = await readConversation(reader(bytes), { mode: 'before', offset: cursor, size: bytes.length }, sizes)
    expect(page.rows.length).toBeLessThanOrEqual(CONVERSATION_ROWS)
    expect(page.rows.every(r => (r.o ?? -1) < cursor)).toBe(true)
    expect(page.isStart || page.start < cursor).toBe(true)
    expect(page.size).toBe(cursor)
    held = [...page.rows, ...held]
    cursor = page.start
    isStart = page.isStart
  }
  expect(isStart).toBe(true)
  expect(held).toEqual(full)
})

test('the live window starts at the newest row held: it rebuilds that row as it grows and follows a growing file; too far back gives the tail with reset', async () => {
  const first = transcript(3)
  const rows = rowsOfTranscript(first.text).rows
  const from = liveFrom(rows) ?? -1
  expect(from).toBe(rows.at(-1)?.o)
  expect(rows.at(-1)?.text).toBe('Read f3.ts · 1 tool')
  const more = `${assistant([{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: 'C:\\repo\\g.ts' } }], 98)}\n`
  const longer = encoder.encode(`${first.text}${more}`)
  const live = await readConversation(reader(longer), { mode: 'from', offset: from, size: longer.length })
  expect(live.rows.map(r => r.text)).toEqual(['Read f3.ts, read g.ts · 2 tools'])
  expect(live.start).toBe(from)
  const merged = mergeLive(rows, live.rows, from)
  expect(merged.rows.length).toBe(rows.length)
  expect(merged.rows.at(-1)?.text).toBe('Read f3.ts, read g.ts · 2 tools')
  expect(merged.added).toBe(0)
  const grown = encoder.encode(`${first.text}${more}${said('Done now.', 99)}\n${user('Next', 100)}\n`)
  const next = await readConversation(reader(grown), { mode: 'from', offset: from, size: grown.length })
  expect(next.rows.map(r => r.text).slice(-2)).toEqual(['Done now.', 'Next'])
  expect(mergeLive(rows, next.rows, from).added).toBe(2)
  expect(next.size).toBe(grown.length)
  const far = await readConversation(reader(grown), { mode: 'from', offset: 0, size: grown.length }, { first: 64, max: 128 })
  expect(far.reset).toBe(true)
  expect(far.size).toBe(grown.length)
})

test('rows over the cap are cut and flagged; offsets in queries are plain integers up to 2^53; the file id names the file', () => {
  const { rows } = rowsOfTranscript(`${user('short', 1)}\n${said('z'.repeat(9000), 2)}\n`)
  expect(rows.map(r => [r.text.length, r.cut])).toEqual([[5, undefined], [8000, true]])
  for (const bad of [null, '', '-1', '1.5', '1e3', 'abc', ' 1', '99999999999999999', '9007199254740993']) expect(offsetParam(bad)).toBe(null)
  expect(offsetParam('0')).toBe(0)
  expect(offsetParam('9007199254740992')).toBe(2 ** 53)
  expect(fileIdOf({ ino: 42, birthtimeMs: 1700000000000.5 })).toBe('42-1700000000000.5')
})

test('chat rows merge by offset: the live window replaces what it covers, older pages go in front, and the cap drops the far end', () => {
  const held = [row('you', 'p1', 10), row('claude', 'r1', 20), row('you', 'p2', 30), row('claude', 'partial', 40)]
  expect(liveFrom(held)).toBe(40)
  expect(liveFrom([row('claude', 'r', 5)])).toBe(5)
  expect(liveFrom([])).toBe(null)
  const live = mergeLive(held, [row('you', 'p2', 30), row('claude', 'partial and more', 40), row('tools', 'Read a.ts · 1 tool', 50), row('claude', 'done', 60)], 30)
  expect(live.rows.map(r => r.text)).toEqual(['p1', 'r1', 'p2', 'partial and more', 'Read a.ts · 1 tool', 'done'])
  expect(live.added).toBe(1)
  expect(live.dropped).toBe(0)
  const capped = mergeLive(held, [row('you', 'p2', 30), row('claude', 'x', 40), row('claude', 'y', 50)], 30, 4)
  expect(capped.rows.map(r => r.o)).toEqual([20, 30, 40, 50])
  expect(capped.dropped).toBe(1)
  const older = mergeOlder(held, [row('you', 'p0', 2), row('claude', 'r0', 5), row('you', 'p1', 10)])
  expect(older.rows.map(r => r.o)).toEqual([2, 5, 10, 20, 30, 40])
  expect(older.dropped).toBe(0)
  const full = mergeOlder(held, [row('you', 'p0', 2), row('claude', 'r0', 5)], 5)
  expect(full.rows.map(r => r.o)).toEqual([2, 5, 10, 20, 30])
  expect(full.dropped).toBe(1)
})

test('the composer names the route and the session; a reply bubble goes once the transcript shows it, a queued one after ten minutes', () => {
  expect(composerLabel('Fix the login bug')).toBe('To Fix the login bug · as you')
  expect(composerLabel('A very long session title that keeps going')).toBe('To A very long session title that… · as you')
  const sentAt = NOW
  const reply: Send = { key: 'local_a', draft: 'Ship  it\nnow ', status: 'sent', message: 'Sent as you.', sentAt, settledAt: sentAt + 1000 }
  const before = [row('you', 'Ship it now', 1, { at: sentAt - 60_000 })]
  expect(chatBubble(reply, before, sentAt + 2000)).toBe(reply)
  expect(chatBubble(reply, [...before, row('you', 'Ship it now', 2, { at: sentAt + 1500 })], sentAt + 2000)).toBe(null)
  expect(chatBubble(reply, [row('claude', 'Ship it now', 2, { at: sentAt + 1500 })], sentAt + 2000)).toBe(reply)
  expect(chatBubble(reply, [], sentAt + 1000 + BUBBLE_KEEP_MS)).toBe(null)
  const note: Send = { key: 'local_a', draft: 'Heads up', status: 'queued', message: 'Note queued at that session; not confirmed read.', sentAt, settledAt: sentAt }
  expect(chatBubble(note, [row('you', 'Heads up', 2, { at: sentAt + 10 })], sentAt + 60_000)).toBe(note)
  expect(chatBubble(note, [], sentAt + BUBBLE_KEEP_MS)).toBe(null)
  const waiting: Send = { key: 'local_a', draft: 'Hi', status: 'waiting', message: 'Not delivered yet', sentAt, replyId: 'r1', createdAt: sentAt }
  expect(chatBubble(waiting, [row('you', 'Hi', 2, { at: sentAt + 10 })], sentAt + BUBBLE_KEEP_MS * 2)).toBe(waiting)
  expect(chatBubble({ ...waiting, status: 'failed', settledAt: sentAt }, [], sentAt + BUBBLE_KEEP_MS * 2)?.status).toBe('failed')
  expect(chatBubble(null, [], NOW)).toBe(null)
})

test('a message the app injected is a one-line event row, not a prompt: never counted, never quoted, and it still starts a turn', () => {
  const reminder = '<system-reminder>\nSECRET-REMINDER about sessions\n</system-reminder>\n\n'
  const transcriptText = [
    user('Start the reviews', 1),
    said('Started them.', 2),
    user(`${reminder}<side-sessions-event>None of the sessions you started is working now; their notes are above.</side-sessions-event>`, 3),
    said('Both reviews are back.', 4),
    user('<cross-session-message from="local_88cd" from-name="CVE detection   gap"> #2171 is merged </cross-session-message>', 5),
    user([{ type: 'text', text: '<ci-monitor-event>"Auto-fix" is watching PR #176</ci-monitor-event>' }], 6),
    user('<side-sessions-event>half a tag', 7),
    user('<artifact-view-context artifact="x">{"view":"a"}</artifact-view-context>\nWhat about this one?', 8),
  ].join('\n')
  const { rows, turns } = rowsOfTranscript(transcriptText)
  expect(rows.map(r => [r.who, r.text])).toEqual([
    ['you', 'Start the reviews'],
    ['claude', 'Started them.'],
    ['event', 'Update from sessions you started'],
    ['claude', 'Both reviews are back.'],
    ['event', 'Message from CVE detection gap'],
    ['event', 'CI monitor update'],
    ['you', '<side-sessions-event>half a tag'],
    ['you', 'What about this one?'],
  ])
  expect(turns).toBe(6)
  expect(rows.filter(r => r.who === 'you').length).toBe(3)
  expect(replyQuote(rows.slice(0, 6))?.text).toBe('Both reviews are back.')
  expect(JSON.stringify(rows)).not.toContain('SECRET')
  expect(mergeLive(rows.slice(0, 3), rows.slice(2, 6), rows[2]?.o ?? 0).added).toBe(1)
})

test('a line that makes several rows is never split by a page edge: rows carry their place on the line, and paging rebuilds every row once', async () => {
  const lines: string[] = []
  for (let n = 1; n <= 30; n += 1) {
    lines.push(user(`Prompt ${n}`, n * 10))
    lines.push(assistant([{ type: 'text', text: `Before ${n}` }, { type: 'tool_use', id: `t${n}`, name: 'Grep', input: { pattern: 'x', path: `C:\\repo\\d${n}` } }, { type: 'text', text: `After ${n}` }], n * 10 + 1))
    lines.push(user([{ type: 'text', text: `Two ${n}a` }, { type: 'text', text: `Two ${n}b` }], n * 10 + 2))
  }
  const text = `${lines.join('\n')}\n`
  const bytes = encoder.encode(text)
  const full = pageRows(textLines(text), 0, { isCut: false, limit: null }).rows
  const shared = full.filter(r => r.o === full[1]?.o)
  expect(shared.map(r => [r.who, r.i])).toEqual([['claude', 0], ['tools', 1], ['claude', 2]])
  expect(full.filter(r => r.o === full[4]?.o).map(r => r.i)).toEqual([0, 1])
  expect(isRowAfter(shared[1] as ConversationRow, shared[0] as ConversationRow)).toBe(true)
  expect(isRowAfter(full[0] as ConversationRow, shared[0] as ConversationRow)).toBe(false)
  for (const sizes of [{ first: 128, max: 512 }, { first: 300, max: 1200 }, { first: 1000, max: 4000 }]) {
    const tail = await readConversation(reader(bytes), { mode: 'tail', size: bytes.length }, sizes)
    let held = tail.rows
    let cursor = tail.start
    let isStart = tail.isStart
    for (let i = 0; i < 400 && !isStart; i += 1) {
      const page = await readConversation(reader(bytes), { mode: 'before', offset: cursor, size: bytes.length }, sizes)
      expect(page.rows.every(r => (r.o ?? -1) < cursor)).toBe(true)
      expect(page.isStart || page.start < cursor).toBe(true)
      held = mergeOlder(held, page.rows, 10_000).rows
      cursor = page.start
      isStart = page.isStart
    }
    expect(isStart).toBe(true)
    expect(held).toEqual(full)
    expect(new Set(held.map(r => `${r.o}:${r.i}`)).size).toBe(held.length)
  }
  const limited = pageRows(textLines(text).slice(0, 7), 0, { isCut: false, limit: 4 })
  expect(limited.rows.map(r => r.who)).toEqual(['claude', 'tools', 'claude', 'you', 'you', 'you'])
  expect(limited.start).toBe(limited.rows[0]?.o)
})

test('a long running turn: refreshing from the newest row reads only what is new, so it never resets, however long the turn grows', async () => {
  let text = `${user('Run the whole migration', 1)}\n`
  let rows = rowsOfTranscript(text).rows
  const sizes = { first: 256, max: 2048 }
  let resets = 0
  let read = 0
  for (let n = 1; n <= 80; n += 1) {
    text += `${assistant([{ type: 'tool_use', id: `t${n}`, name: 'Bash', input: { command: 'npm test' } }], n * 2)}\n${user([{ type: 'tool_result', tool_use_id: `t${n}`, content: 'z'.repeat(150) }], n * 2 + 1)}\n`
    if (n % 3 === 0) text += `${said(`Step ${n} done.`, n * 2 + 1)}\n`
    const bytes = encoder.encode(text)
    const from = liveFrom(rows) ?? 0
    read = Math.max(read, bytes.length - from)
    const page = await readConversation(reader(bytes), { mode: 'from', offset: from, size: bytes.length }, sizes)
    if (page.reset) resets += 1
    rows = mergeLive(rows, page.rows, from).rows
  }
  expect(encoder.encode(text).length).toBeGreaterThan(sizes.max * 10)
  expect(resets).toBe(0)
  expect(read).toBeLessThan(sizes.max)
  expect(rows).toEqual(pageRows(textLines(text), 0, { isCut: false, limit: null }).rows)
})

const plainOf = (inline: { text: string }[] | undefined) => (inline ?? []).map(part => part.text).join('')

test('markdown tables: a header and a delimiter line make a table with alignments, short rows are padded, long ones join into the last cell, and pipes inside code stay', () => {
  const blocks = parseMarkdown(['Before', '| Part | `a|b` | Size |', '|:--|:-:|--:|', '| one | `x | y` | 1 |', '| two |', 'three | 3 | extra | more', 'after \\| escaped | z | 2', '', 'Done'].join('\n'))
  expect(blocks.map(b => b.type)).toEqual(['para', 'table', 'para'])
  const table = blocks[1]
  if (table?.type !== 'table') throw new Error('no table')
  expect(table.align).toEqual(['left', 'center', 'right'])
  expect(table.head.map(plainOf)).toEqual(['Part', 'a|b', 'Size'])
  expect(table.head[1]).toEqual([{ type: 'code', text: 'a|b' }])
  expect(table.rows.map(r => r.map(plainOf))).toEqual([
    ['one', 'x | y', '1'],
    ['two', '', ''],
    ['three', '3', 'extra | more'],
    ['after | escaped', 'z', '2'],
  ])
  expect(table.rows[0]?.[1]).toEqual([{ type: 'code', text: 'x | y' }])
  expect(parseMarkdown('| a | b |\n|---|---|')).toEqual([{ type: 'table', align: [null, null], head: [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }]], rows: [] }])
})

test('markdown tables: no table without a matching delimiter line, setext and rule lines stay text, and the column and row caps hold', () => {
  expect(parseMarkdown('| a | b |\n| c | d |').map(b => b.type)).toEqual(['para'])
  expect(parseMarkdown('a | b\n--- | --- | ---').map(b => b.type)).toEqual(['para'])
  expect(parseMarkdown('Title\n---').map(b => b.type)).toEqual(['para'])
  expect(parseMarkdown('a | b\n---').map(b => b.type)).toEqual(['para'])
  expect(parseMarkdown('| a | b |\n|---|-x-|').map(b => b.type)).toEqual(['para'])
  expect(parseMarkdown('1. Run:\n   ```sh\n   npm test\n     --watch\n x\n   ```')[1]).toEqual({ type: 'code', lang: 'sh', text: 'npm test\n  --watch\nx' })
  expect(tableCells('no pipes here')).toBe(null)
  expect(tableCells('| a | `b|c` |')).toEqual(['a', '`b|c`'])
  const wide = Array.from({ length: MARKDOWN_TABLE_COLUMNS + 1 }, (_, i) => `c${i}`)
  expect(parseMarkdown(`${wide.join(' | ')}\n${wide.map(() => '---').join(' | ')}`).map(b => b.type)).toEqual(['para'])
  const body = Array.from({ length: MARKDOWN_TABLE_ROWS + 3 }, (_, i) => `| r${i} | ${i} |`)
  const long = parseMarkdown(['| name | n |', '|---|---|', ...body, '```', 'code | not a row', '```'].join('\n'))
  expect(long.map(b => b.type)).toEqual(['table', 'para', 'code'])
  expect(long[0]?.type === 'table' && long[0].rows.length).toBe(MARKDOWN_TABLE_ROWS)
  expect(long[1]?.type === 'para' && plainOf(long[1].inline)).toBe(body.slice(MARKDOWN_TABLE_ROWS).join('\n'))
  const started = Date.now()
  for (const hostile of ['|`'.repeat(4000), '| a |\n|---|\n'.repeat(500), `${'|'.repeat(4000)}\n${'|-'.repeat(2000)}`]) parseMarkdown(hostile)
  expect(Date.now() - started).toBeLessThan(1000)
})

test('chat grouping: one Claude header per turn, a new one after a gap or a day change, questions always headed, and day dividers where the local day changes', () => {
  const day = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()
  const now = day(10, 18)
  expect(dayLabel(day(10, 0, 1), now)).toBe('Today')
  expect(dayLabel(day(9, 23, 59), now)).toBe('Yesterday')
  expect(dayLabel(day(2, 9), now)).toBe('Mon 2 Nov')
  expect(dayLabel(new Date(2025, 11, 31, 9).getTime(), now)).toBe('Wed 31 Dec 2025')
  const rows: ConversationRow[] = [
    { who: 'you', text: 'p1', at: day(9, 22), o: 1 },
    { who: 'claude', text: 'a', at: day(9, 22, 1), o: 2 },
    { who: 'tools', text: 'Read a.ts · 1 tool', at: day(9, 22, 2), o: 3 },
    { who: 'claude', text: 'b', at: day(9, 22, 3), o: 4 },
    { who: 'claude', text: 'c', at: day(9, 22, 3) + TURN_GAP_MS + 1, o: 5 },
    { who: 'question', text: 'Which?\n- x', at: day(9, 22, 30), o: 6 },
    { who: 'claude', text: 'd', at: day(9, 22, 31), o: 7 },
    { who: 'tools', text: 'Ran npm test · 1 tool', at: day(10, 0, 5), o: 8 },
    { who: 'claude', text: 'e', at: day(10, 0, 6), o: 9 },
    { who: 'event', text: 'CI monitor update', at: day(10, 0, 7), o: 10 },
    { who: 'claude', text: 'f', at: null, o: 11 },
  ]
  expect(chatMarks(rows, now).map(m => [m.day, m.head, m.turn])).toEqual([
    ['Yesterday', false, true],
    [null, true, true],
    [null, false, false],
    [null, false, false],
    [null, true, true],
    [null, true, true],
    [null, true, true],
    ['Today', false, true],
    [null, true, true],
    [null, false, true],
    [null, true, true],
  ])
  expect(chatMarks(rows.slice(8), now).map(m => m.day)).toEqual([null, null, null])
  expect(chatMarks([], now)).toEqual([])
})

test('the chat header counts prompts: "N prompts" once the start and the end are held, else "N+ prompts", with a tooltip saying which', () => {
  const rows = [row('you', 'a', 1), row('claude', 'b', 2), row('event', 'CI monitor update', 3), row('you', 'c', 4)]
  expect(promptCount(rows, true)).toEqual({ text: '2 prompts', title: 'Prompts in this conversation' })
  expect(promptCount(rows, false)).toEqual({ text: '2+ prompts', title: 'Prompts loaded so far' })
  expect(promptCount([row('claude', 'b', 2)], false).text).toBe('1+ prompts')
  expect(promptCount([row('you', 'a', 1)], true).text).toBe('1 prompt')
})

test('the composer carries its route in the placeholder and the focus hint; the read-only line is short', () => {
  expect(composerHint()).toEqual({ placeholder: 'Reply as you' })
  expect(readOnlyShort({ messageBlock: 'asleep' })).toBe('Asleep. Wake it from Claude desktop to reply here.')
  expect(readOnlyShort({ messageBlock: 'no-id' })).toBe('Read only: no Claude Code id.')
  expect(readOnlyShort({})).toBe('Ended: read only.')
})

test('the asleep card is one line: what happened and how to wake it, then that it is waking', () => {
  expect(asleepCardText('asleep')).toEqual({ title: 'Asleep', line: 'Paused while idle. Press to wake up.', label: 'Wake up' })
  expect(asleepCardText('waking').title).toBe('Waking up…')
  expect(asleepCardText('stalled')).toMatchObject({ title: 'Still asleep', label: 'Try waking it again' })
  expect(asleepCardText('failed', 'Reconnecting to Orbit: try again in a moment.').line).toBe('Reconnecting to Orbit: try again in a moment. Press to try again.')
})

test('Orbit can wake an asleep desktop session it can open; an ended one, or one it cannot open, it cannot', () => {
  const asleep = { messageBlock: 'asleep' as const, canOpen: true }
  expect(canWake(asleep)).toBe(true)
  expect(canWake({ ...asleep, canOpen: false })).toBe(false)
  expect(canWake({ messageBlock: 'ended' as const, canOpen: true })).toBe(false)
  expect(canWake({ messageBlock: null, canOpen: true })).toBe(false)
})

test('questions list their options with the recommended one in bold; a command whose output is assigned names its program, never a flag', () => {
  const question = assistant([{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [{ question: 'Keep the switch?', options: [{ label: 'Remove it fully (Recommended)' }, { label: 'Keep  only the switch' }] }] } }], 1)
  const asked = rowsOfTranscript(question).rows[0]
  expect(asked?.text).toBe('Keep the switch?\n- **Remove it fully** (recommended)\n- Keep only the switch')
  const list = parseMarkdown(asked?.text ?? '')[1]
  expect(list?.type === 'list' && list.items[0]?.inline).toEqual([{ type: 'bold', text: 'Remove it fully' }, { type: 'text', text: ' (recommended)' }])
  expect(commandHead('H=$(grep -n "</head>" index.html | cut -d: -f1); echo "$H"')).toBe('grep')
  expect(commandHead('X=`node -e 1`')).toBe('node')
  expect(commandHead('X=$( sed -n 1p f)')).toBe('sed')
  expect(commandHead('X=$(pwd)')).toBe('pwd')
  expect(commandHead('grep foo \\\n  -n bar | wc -l')).toBe('grep')
  expect(commandHead('-n x; ls')).toBe('ls')
  const run = assistant(
    [
      { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'sed -n 1,5p a.txt' } },
      { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'grep -rn x .' } },
      { type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'H=$(grep -n "</head>" a.html | cut -d: -f1); echo "$H"' } },
      { type: 'tool_use', id: 'd', name: 'Bash', input: { command: 'P=$(powershell -NoProfile -Command "x")' } },
    ],
    2,
  )
  expect(rowsOfTranscript(run).rows[0]?.text).toBe('Ran sed, ran grep, ran powershell · 4 tools')
})

test('the pinned prompt is the one that started the turn in view: hidden while its row shows or the next prompt starts under the bar, the newest once a long last turn scrolls it out, none above the first prompt', () => {
  const box = (top: number, height = 40) => ({ top, bottom: top + height })
  expect(pinnedPrompt([])).toBe(null)
  expect(pinnedPrompt([box(10), box(300)])).toBe(null)
  expect(pinnedPrompt([box(-200), box(-90), box(120)])).toBe(1)
  expect(pinnedPrompt([box(-200), box(-20), box(120)])).toBe(null)
  expect(pinnedPrompt([box(-200), box(-30 - PIN_VISIBLE_PX + 1)])).toBe(1)
  expect(pinnedPrompt([box(-200), box(-40 + PIN_VISIBLE_PX)])).toBe(null)
  expect(pinnedPrompt([box(-1800), box(-900, 60)])).toBe(1)
  expect(pinnedPrompt([box(-400, 600)])).toBe(null)
  expect(pinnedPrompt([box(0), box(50)])).toBe(null)
  expect(pinnedPrompt([box(-300), box(PIN_COVER_PX - 1)])).toBe(null)
  expect(pinnedPrompt([box(-300), box(PIN_COVER_PX)])).toBe(0)
  expect(pinnedPrompt([box(-300), box(20)], 0)).toBe(0)
})

test('question drafts: single-select replaces, multi-select adds up, Other stands alone; the post names only answered questions, trims notes, and passes the server rules', () => {
  const colour = { question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }
  const fruit = { question: 'Which fruits?', header: 'Fruit', multiSelect: true, options: [{ label: 'Apple', description: '' }, { label: 'Pear', description: '' }, { label: 'Plum', description: '' }] }
  const asked = [colour, fruit]
  let c = chooseOption(false, emptyQuestionDraft(), 'Red', true)
  c = chooseOption(false, c, 'Blue', true)
  expect(c.labels).toEqual(['Blue'])
  expect(chooseOption(false, c, null, true)).toEqual({ labels: [], isOther: true, other: '', note: '' })
  let f = chooseOption(true, emptyQuestionDraft(), 'Plum', true)
  f = chooseOption(true, f, 'Apple', true)
  expect(f.labels).toEqual(['Plum', 'Apple'])
  expect(chooseOption(true, f, 'Plum', false).labels).toEqual(['Apple'])
  const other = chooseOption(true, { ...f, other: 'kiwi' }, null, true)
  expect([other.labels, other.isOther, other.other]).toEqual([[], true, 'kiwi'])
  expect(chooseOption(true, other, 'Pear', true)).toEqual({ labels: ['Pear'], isOther: false, other: 'kiwi', note: '' })
  expect(chooseOption(true, other, null, false).isOther).toBe(false)

  expect(questionHint(asked, {})).toBe('Still to answer: Colour, Fruit.')
  expect(questionPost(asked, {})).toEqual({ answers: {} })
  expect(questionHint(asked, { [colour.question]: c })).toBe('Still to answer: Fruit.')
  const otherColour = { ...chooseOption(false, c, null, true), other: '  ' }
  expect(questionHint(asked, { [colour.question]: otherColour, [fruit.question]: f })).toBe('Type your Other answer for Colour.')
  expect(questionHint([{ ...colour, header: '' }], {})).toBe('Still to answer: Which colour?.')

  const drafts = { [colour.question]: { ...otherColour, other: ' teal ', note: '  ' }, [fruit.question]: { ...f, note: ' ripe only \n' } }
  expect(questionHint(asked, drafts)).toBe(null)
  const post = questionPost(asked, drafts)
  expect(post).toEqual({ answers: { [colour.question]: { other: ' teal ' }, [fruit.question]: { labels: ['Plum', 'Apple'] } }, notes: { [fruit.question]: 'ripe only' } })
  const checked = checkQuestionAnswer(asked, post)
  expect(checked.ok && [checked.answers, checked.notes]).toEqual([{ [colour.question]: 'teal', [fruit.question]: 'Apple, Plum' }, { [fruit.question]: 'ripe only' }])
  expect(checkQuestionAnswer(asked, questionPost(asked, { [colour.question]: c })).ok).toBe(false)
})

test('S1: a new question card takes focus only from the request slot it replaces, never from the page body, the details, the composer, a text field, the list or the graph', () => {
  const focus = (patch: Partial<Parameters<typeof mayFocusNewCard>[0]> = {}) => mayFocusNewCard({ isBody: false, isInDetails: false, isInComposer: false, isTextField: false, isInRequests: false, ...patch })
  expect(focus({ isBody: true })).toBe(false)
  expect(focus({ isInDetails: true })).toBe(false)
  expect(focus()).toBe(false)
  expect(focus({ isInDetails: true, isInComposer: true, isTextField: true })).toBe(false)
  expect(focus({ isInRequests: true })).toBe(true)
  expect(focus({ isInRequests: true, isTextField: true })).toBe(false)
})

test('a question named __proto__ still posts', () => {
  const odd = { question: '__proto__', header: 'Odd', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }
  const post = questionPost([odd], Object.fromEntries([['__proto__', { labels: ['A'], isOther: false, other: '', note: 'n' }]]))
  expect(JSON.stringify(post)).toBe('{"answers":{"__proto__":{"labels":["A"]}},"notes":{"__proto__":"n"}}')
  expect(checkQuestionAnswer([odd], JSON.parse(JSON.stringify(post))).ok).toBe(true)
})

test('tabbed questions: a single-select choice moves on (the last to Submit), multi-select and Other stay; tabs know what is answered; the review reads like the answer Claude gets', () => {
  expect(tabAfterChoice(0, 3, false, 'Red', true)).toBe(1)
  expect(tabAfterChoice(2, 3, false, 'Red', true)).toBe(3)
  expect(tabAfterChoice(0, 3, false, null, true)).toBe(null)
  expect(tabAfterChoice(1, 3, true, 'Apple', true)).toBe(null)
  expect(tabAfterChoice(0, 3, false, 'Red', false)).toBe(null)
  const colour = { question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }
  const fruit = { question: 'Which fruits?', header: 'Fruit', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Pear' }, { label: 'Plum' }] }
  const name = { question: 'What name should the new release have, given everything above?', header: ' ', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }
  const asked = [colour, fruit, name]
  const drafts = {
    [colour.question]: { labels: [], isOther: true, other: ' teal ', note: '' },
    [fruit.question]: { labels: ['Plum', 'Apple'], isOther: false, other: '', note: ' ripe ' },
    [name.question]: { labels: [], isOther: true, other: '  ', note: '' },
  }
  expect(answeredQuestions(asked, drafts)).toEqual([true, true, false])
  expect(answeredQuestions(asked, {})).toEqual([false, false, false])
  expect(questionReview(asked, drafts)).toEqual([
    { index: 0, name: 'Colour', answer: 'Other: teal', note: null, isAnswered: true },
    { index: 1, name: 'Fruit', answer: 'Apple, Plum', note: 'ripe', isAnswered: true },
    { index: 2, name: 'What name should the new release have,…', answer: null, note: null, isAnswered: false },
  ])
})

test('words said mid-turn are your rows: a prompt typed in Claude while it worked, and a reply Orbit steered in; other attachments are not', () => {
  const attached = (attachment: unknown, s: number, extra: Record<string, unknown> = {}) => line({ type: 'attachment', timestamp: at(s), attachment, ...extra })
  const transcriptText = [
    user('Fix the build', 1),
    said('Looking.', 2),
    attached({ type: 'queued_command', prompt: 'also check the tests', origin: { kind: 'human' } }, 3),
    attached({ type: 'queued_command', prompt: 'a task notification', origin: { kind: 'task-notification' } }, 4),
    attached({ type: 'hook_additional_context', content: [steerContext('use the staging config')] }, 5),
    attached({ type: 'hook_additional_context', content: ['some other hook said this'] }, 6),
    attached({ type: 'queued_command', prompt: 'from a sub-agent', origin: { kind: 'human' } }, 7, { isSidechain: true }),
    said('Done.', 8),
  ].join('\n')
  const { rows } = rowsOfTranscript(transcriptText)
  expect(rows.map(r => [r.who, r.text])).toEqual([
    ['you', 'Fix the build'],
    ['claude', 'Looking.'],
    ['you', 'also check the tests'],
    ['you', 'use the staging config'],
    ['claude', 'Done.'],
  ])
})

test('a sub-agent transcript reads its own sidechain lines as its prompt and replies', () => {
  const side = (json: string) => JSON.stringify({ ...JSON.parse(json), isSidechain: true })
  const lines = [side(user('Find the flaky test', 1)), side(said('Found it in the stage tests.', 2))].join('\n')
  const hidden = pageRows(textLines(lines, 0), 0, { isCut: false, limit: CONVERSATION_ROWS })
  expect(hidden.rows).toEqual([])
  const shown = pageRows(textLines(lines, 0), 0, { isCut: false, limit: CONVERSATION_ROWS, isSidechain: true })
  expect(shown.rows.map(r => [r.who, r.text])).toEqual([
    ['you', 'Find the flaky test'],
    ['claude', 'Found it in the stage tests.'],
  ])
})

test('a background sub-agent report handed back to its caller reads as its reply, not as a tool', () => {
  const side = (json: string) => JSON.stringify({ ...JSON.parse(json), isSidechain: true })
  const handback = assistant([{ type: 'tool_use', id: 'h', name: 'SubagentHandback', input: { message: 'GREEN: the PR is ready.' } }], 3)
  const lines = [side(user('Run the loop', 1)), side(assistant([{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'git status' } }], 2)), side(handback)].join('\n')
  const shown = pageRows(textLines(lines, 0), 0, { isCut: false, limit: CONVERSATION_ROWS, isSidechain: true })
  expect(shown.rows.map(r => r.who)).toEqual(['you', 'tools', 'claude'])
  expect(shown.rows.at(-1)?.text).toBe('GREEN: the PR is ready.')
  expect(shown.rows[1]?.text).toContain('1 tool')
})

test('the desktop next-step box reads as a Claude row with its question, its reply buttons as choices in order; one that asks nothing adds no row and no tool count', () => {
  const asks = assistant(
    [{ type: 'tool_use', id: 'w', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'The plan is in the note.', ask: 'Build it  here?', actions: [{ label: 'Yes, build here' }, { action: 'commit' }, { label: 'Not now' }], blocked: true } }],
    1,
  )
  const rows = rowsOfTranscript(asks).rows.filter(r => r.who !== 'plan')
  expect(rows.map(r => [r.who, r.text, r.choices, r.next])).toEqual([['claude', 'The plan is in the note.\n\n**Build it here?**', ['Yes, build here', 'Not now'], true]])
  const quiet = assistant([{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 'w', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Done.' } }], 2)
  expect(rowsOfTranscript(quiet).rows.filter(r => r.who !== 'plan').map(r => r.text)).toEqual(['Ran ls · 1 tool'])
})

test('2.4.2: while Orbit shows a question card its row is left out, so the question is not drawn twice; the answered row comes back (Jak 2026-11-25)', () => {
  const r = (who: ConversationRow['who'], text: string, answered?: true): ConversationRow => ({ who, at: null, text, ...(answered ? { answered } : {}) })
  const rows = [r('you', 'a'), r('question', 'Old one?\n→ **x**', true), r('claude', 'next'), r('question', 'Which  branch\nshould I push?\n- main\n- dev')]
  expect(withoutOpenQuestion(rows, 'Which branch should I push?').map(x => x.text)).toEqual(['a', 'Old one?\n→ **x**', 'next'])
  expect(withoutOpenQuestion(rows, null)).toBe(rows)
  expect(withoutOpenQuestion(rows, 'Something else?')).toBe(rows)
  expect(withoutOpenQuestion([r('question', 'Old one?\n→ **x**', true)], 'Old one?')).toHaveLength(1)
})

test('2.4.2: the next-step box is drawn after the closing message the agent writes once it is filled, and after the rest of its turn; the next prompt or event ends the turn (Jak 2026-11-25)', () => {
  const turn = [
    user('Run the suite', 1),
    assistant([{ type: 'tool_use', id: 'w', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Same 48 failures.', ask: 'Merge master in?', actions: [{ label: 'Only if GitHub asks' }, { label: 'Merge now' }] } }], 2),
    said('**The branch adds no failures.**\n\n| | Failed |\n|---|---|\n| Branch | 48 |', 3),
  ].join('\n')
  const rows = rowsOfTranscript(turn).rows.filter(r => r.who !== 'plan')
  expect(rows.map(r => r.who)).toEqual(['you', 'claude', 'claude'])
  expect(rows[1]?.next).toBe(true)
  const drawn = nextStepLast(rows)
  expect(drawn.map(r => r.text.slice(0, 12))).toEqual(['Run the suit', '**The branch', 'Same 48 fail'])
  expect(drawn.at(-1)?.choices).toEqual(['Only if GitHub asks', 'Merge now'])
  expect(rows[1]?.next).toBe(true)

  const r = (who: ConversationRow['who'], text: string, next?: true): ConversationRow => ({ who, at: null, text, ...(next ? { next } : {}) })
  const two = [r('you', 'a'), r('claude', 'box 1', true), r('tools', 'ran'), r('claude', 'close 1'), r('event', 'note'), r('you', 'b'), r('claude', 'box 2', true)]
  expect(nextStepLast(two).map(x => x.text)).toEqual(['a', 'ran', 'close 1', 'box 1', 'note', 'b', 'box 2'])
  const plain = [r('you', 'a'), r('claude', 'only')]
  expect(nextStepLast(plain)).toEqual(plain)
})

test('the desktop task list: each call is a hidden plan row that does not split a run of tools, folded into the list as it stands; the next-step box checks it off and the next prompt clears it', () => {
  const plan = (input: unknown, id: string) => ({ type: 'tool_use', id, name: 'mcp__ccd_turn__update_plan', input })
  const read = (id: string, file: string) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: `C:\\repo\\${file}` } })
  const lines = [
    user('Fix it', 1),
    assistant([plan({ items: [{ content: 'Look  at the code', status: 'in_progress' }, { content: 'Fix it', status: 'pending' }, { content: 'Test', status: 'pending' }, { content: 42, status: 'pending' }], scope: 'continuation' }, 'p1'), read('r1', 'a.ts')], 2),
    assistant([read('r2', 'b.ts'), plan({ advance: true }, 'p2')], 3),
  ]
  const mid = rowsOfTranscript(lines.join('\n')).rows
  expect(mid.filter(r => r.who !== 'plan').map(r => [r.who, r.text])).toEqual([['you', 'Fix it'], ['tools', 'Read a.ts, read b.ts · 2 tools']])
  expect(taskList(mid)).toEqual([
    { content: 'Look at the code', status: 'completed' },
    { content: 'Fix it', status: 'in_progress' },
    { content: 'Test', status: 'pending' },
  ])
  const steered = [...lines, user('also check c.ts', 4), assistant([plan({ done: [2], start: 3 }, 'p3')], 5)]
  expect(taskList(rowsOfTranscript(steered.join('\n')).rows)?.map(s => s.status)).toEqual(['completed', 'completed', 'in_progress'])
  const ended = [...steered, assistant([{ type: 'tool_use', id: 'w', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Fixed.' } }], 6)]
  expect(taskList(rowsOfTranscript(ended.join('\n')).rows)?.map(s => s.status)).toEqual(['completed', 'completed', 'completed'])
  expect(taskList(rowsOfTranscript([...ended, user('Thanks', 7)].join('\n')).rows)).toBe(null)
  expect(taskList(rowsOfTranscript(lines.slice(2).join('\n')).rows)).toBe(null)
})

test('a slash command reads as your row with its arguments, and what it printed as a Claude row without colour codes; empty output adds nothing', () => {
  const lines = [
    line({ type: 'user', timestamp: at(1), message: { role: 'user', content: '<command-message>remote-control</command-message>\n<command-name>/remote-control</command-name>\n<command-args>on</command-args>' } }),
    line({ type: 'user', timestamp: at(2), message: { role: 'user', content: '<local-command-stdout>\u001b[1mRemote Control\u001b[22m is on</local-command-stdout>' } }),
    line({ type: 'user', timestamp: at(3), message: { role: 'user', content: '<local-command-stdout>(no content)</local-command-stdout>' } }),
    line({ type: 'user', timestamp: at(4), message: { role: 'user', content: '<local-command-stderr>Unknown flag</local-command-stderr>' } }),
  ].join('\n')
  expect(rowsOfTranscript(lines).rows.map(r => [r.who, r.text])).toEqual([
    ['you', '/remote-control on'],
    ['claude', 'Remote Control is on'],
    ['claude', 'Unknown flag'],
  ])
})

test('a message shows a spinner while it is on its way to the agent, never once refused, expired or unknown', () => {
  for (const status of ['sending', 'waiting', 'held', 'queued', 'sent'] as const) expect(isAwaitingAgent(status)).toBe(true)
  for (const status of ['failed', 'unknown', 'expired'] as const) expect(isAwaitingAgent(status)).toBe(false)
})
