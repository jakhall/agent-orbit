// @ts-check

export const MARKDOWN_MAX_CHARS = 8000
export const MARKDOWN_TABLE_COLUMNS = 8
export const MARKDOWN_TABLE_ROWS = 50

/**
 * @typedef {object} Inline a run of text inside a block
 * @property {'text' | 'code' | 'bold' | 'italic'} type
 * @property {string} text
 */

/** @typedef {'left' | 'center' | 'right' | null} Align */

/**
 * @typedef {{ type: 'code', lang: string, text: string }
 *   | { type: 'para', inline: Inline[] }
 *   | { type: 'heading', inline: Inline[] }
 *   | { type: 'list', ordered: boolean, start: number, items: { inline: Inline[], indent: number }[] }
 *   | { type: 'table', align: Align[], head: Inline[][], rows: Inline[][][] }} Block
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*)$/
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const DELIMITER_CELL = /^:?-+:?$/

/**
 * @param {Inline[]} out
 * @param {Inline['type']} type
 * @param {string} text
 */
function push(out, type, text) {
  if (!text) return
  const last = out.at(-1)
  if (type === 'text' && last?.type === 'text') last.text += text
  else out.push({ type, text })
}

/**
 * Inline code (backtick runs), bold (`**`) and italic (`*`) in one line of
 * text, in linear time: an opener with no closer left in the text is kept as
 * literal text, and no other formatting nests inside a run.
 * @param {string} text
 * @returns {Inline[]}
 */
export function parseInline(text) {
  /** @type {Inline[]} */
  const out = []
  /** @type {Set<string>} */
  const unclosed = new Set()
  let i = 0
  let plain = 0
  const flush = (/** @type {number} */ end) => push(out, 'text', text.slice(plain, end))
  while (i < text.length) {
    const c = text[i]
    if (c === '`') {
      let n = 1
      while (text[i + n] === '`') n += 1
      const fence = '`'.repeat(n)
      const close = unclosed.has(fence) ? -1 : text.indexOf(fence, i + n)
      if (close < 0) {
        unclosed.add(fence)
        i += n
        continue
      }
      flush(i)
      const inner = text.slice(i + n, close)
      push(out, 'code', inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') ? inner.slice(1, -1) : inner)
      i = close + n
      plain = i
      continue
    }
    if (c === '*' && text[i + 1] === '*') {
      const close = unclosed.has('**') ? -1 : text.indexOf('**', i + 2)
      if (close < 0) unclosed.add('**')
      else if (close > i + 2 && text[i + 2] !== ' ' && text[close - 1] !== ' ') {
        flush(i)
        push(out, 'bold', text.slice(i + 2, close))
        i = close + 2
        plain = i
        continue
      }
      i += 2
      continue
    }
    if (c === '*') {
      const close = text.indexOf('*', i + 1)
      if (close > i + 1 && text[close + 1] !== '*' && text[i + 1] !== ' ' && text[close - 1] !== ' ') {
        flush(i)
        push(out, 'italic', text.slice(i + 1, close))
        i = close + 1
        plain = i
        continue
      }
    }
    i += 1
  }
  flush(text.length)
  return out
}

/**
 * @param {string} text a heading's text, without its closing hashes
 * @returns {string}
 */
function headingText(text) {
  const trimmed = text.trimEnd()
  let end = trimmed.length
  while (end > 0 && trimmed[end - 1] === '#') end -= 1
  if (end === trimmed.length || (end > 0 && !/[ \t]/.test(trimmed[end - 1] ?? ''))) return trimmed
  return trimmed.slice(0, end).trimEnd()
}

/**
 * The cells of a table line: split on `|` outside backtick code spans, a
 * leading and trailing pipe dropped, `\|` kept as a literal pipe. Null when
 * the line has no such pipe.
 * @param {string} line
 * @returns {string[] | null}
 */
export function tableCells(line) {
  const text = line.trim()
  /** @type {string[]} */
  const cells = []
  /** @type {Set<number>} */
  const unclosed = new Set()
  let cell = ''
  let pipes = 0
  for (let i = 0; i < text.length; ) {
    const c = text[i]
    if (c === '\\' && text[i + 1] === '|') {
      cell += '|'
      i += 2
      continue
    }
    if (c === '`') {
      let n = 1
      while (text[i + n] === '`') n += 1
      const close = unclosed.has(n) ? -1 : text.indexOf('`'.repeat(n), i + n)
      if (close < 0) {
        unclosed.add(n)
        cell += text.slice(i, i + n)
        i += n
        continue
      }
      cell += text.slice(i, close + n).replace(/\\\|/g, '|')
      i = close + n
      continue
    }
    if (c === '|') {
      pipes += 1
      if (i > 0) cells.push(cell)
      cell = ''
      i += 1
      continue
    }
    cell += c
    i += 1
  }
  if (pipes === 0) return null
  if (!text.endsWith('|') || text.endsWith('\\|')) cells.push(cell)
  return cells.map(c => c.trim())
}

/**
 * The alignments of a table's delimiter line (`| :-- | :-: | --: |`), or
 * null when it is not one.
 * @param {string} line
 * @returns {Align[] | null}
 */
function delimiterRow(line) {
  if (!line.includes('|') || !line.includes('-')) return null
  const cells = tableCells(line)
  if (!cells || cells.length === 0 || !cells.every(c => DELIMITER_CELL.test(c))) return null
  return cells.map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null))
}

/**
 * @param {string[]} cells
 * @param {number} width
 * @returns {Inline[][]}
 */
function tableRow(cells, width) {
  const fitted = cells.length > width ? [...cells.slice(0, width - 1), cells.slice(width - 1).join(' | ')] : cells
  return Array.from({ length: width }, (_, i) => parseInline(fitted[i] ?? ''))
}

/**
 * A message's text as a small, safe set of blocks: fenced code, paragraphs,
 * bullet and numbered lists (one level; deeper items keep an indent of 1),
 * headings (drawn as a bold line) and tables, with inline code, bold and
 * italic. A table needs a header line and a delimiter line with the same
 * number of cells and at most `MARKDOWN_TABLE_COLUMNS`; its body runs while
 * lines hold a pipe, short rows are padded, the cells of long ones past the
 * last column are joined into it, and rows past `MARKDOWN_TABLE_ROWS` stay
 * literal text. Everything else, HTML and links included, stays literal
 * text. The input is cut at `MARKDOWN_MAX_CHARS`; the work is linear in its
 * length.
 * @param {string} source
 * @returns {Block[]}
 */
export function parseMarkdown(source) {
  const lines = source.slice(0, MARKDOWN_MAX_CHARS).replace(/\r\n?/g, '\n').split('\n')
  /** @type {Block[]} */
  const blocks = []
  /** @type {string[]} */
  let para = []
  /** @type {Extract<Block, { type: 'list' }> | null} */
  let list = null
  const closePara = () => {
    if (para.length) blocks.push({ type: 'para', inline: parseInline(para.join('\n')) })
    para = []
  }
  const close = () => {
    closePara()
    list = null
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = /** @type {string} */ (lines[i])
    const fence = FENCE.exec(line)
    if (fence && !(fence[1]?.startsWith('`') && fence[2]?.includes('`'))) {
      close()
      const mark = /** @type {string} */ (fence[1])
      const indent = line.length - line.trimStart().length
      /** @type {string[]} */
      const body = []
      let j = i + 1
      for (; j < lines.length; j += 1) {
        const end = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(/** @type {string} */ (lines[j]))
        if (end && end[1]?.[0] === mark[0] && /** @type {string} */ (end[1]).length >= mark.length) break
        const text = /** @type {string} */ (lines[j])
        body.push(text.slice(Math.min(indent, text.length - text.trimStart().length)))
      }
      blocks.push({ type: 'code', lang: (fence[2] ?? '').trim().split(/\s/)[0]?.slice(0, 20) ?? '', text: body.join('\n') })
      i = j
      continue
    }
    if (line.trim() === '') {
      close()
      continue
    }
    const head = line.includes('|') ? tableCells(line) : null
    const align = head && head.length > 0 && head.length <= MARKDOWN_TABLE_COLUMNS && i + 1 < lines.length ? delimiterRow(/** @type {string} */ (lines[i + 1])) : null
    if (head && align && align.length === head.length) {
      close()
      const width = head.length
      /** @type {Inline[][][]} */
      const rows = []
      /** @type {string[]} */
      const rest = []
      let j = i + 2
      for (; j < lines.length; j += 1) {
        const next = /** @type {string} */ (lines[j])
        if (next.trim() === '' || FENCE.test(next)) break
        const cells = next.includes('|') ? tableCells(next) : null
        if (!cells) break
        if (rows.length < MARKDOWN_TABLE_ROWS) rows.push(tableRow(cells, width))
        else rest.push(next)
      }
      blocks.push({ type: 'table', align, head: tableRow(head, width), rows })
      if (rest.length) blocks.push({ type: 'para', inline: parseInline(rest.join('\n')) })
      i = j - 1
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      close()
      blocks.push({ type: 'heading', inline: parseInline(headingText(heading[1] ?? '')) })
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      const marker = /** @type {string} */ (item[2])
      const ordered = /\d/.test(marker)
      const indent = (item[1] ?? '').replace(/\t/g, '  ').length >= 2 ? 1 : 0
      closePara()
      if (!list || list.ordered !== ordered) {
        list = { type: 'list', ordered, start: ordered ? Number.parseInt(marker, 10) : 1, items: [] }
        blocks.push(list)
      }
      list.items.push({ inline: parseInline(item[3] ?? ''), indent })
      continue
    }
    if (list && /^[ \t]{2,}\S/.test(line)) {
      const last = list.items.at(-1)
      if (last) {
        push(last.inline, 'text', ' ')
        for (const part of parseInline(line.trim())) push(last.inline, part.type, part.text)
        continue
      }
    }
    list = null
    para.push(line)
  }
  close()
  return blocks
}
