import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
const page = name => read(`../../companion/inbox/${name}.js`)
const pageModules = () => fs.readdirSync(new URL('../../companion/inbox/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `../../companion/inbox/${f}`)

test('2.1.2: the node quick menu is gone from the page, its script and its styles', () => {
  for (const file of ['../../companion/inbox.html', ...pageModules(), '../../companion/inbox/constellation.css']) {
    assert.doesNotMatch(read(file), /node-menu|placeNodeMenu|nodeMenu|MENU_GAP_PX/, file)
  }
})

test('2.1.2: d, h, s and Shift+S act on the selected session without the menu', () => {
  const main = page('keys')
  assert.match(main, /done: \(\) => key && void triage\('done', key\)/)
  assert.match(main, /hide: \(\) => key && void triage\('hide', key\)/)
  assert.match(main, /'snooze-hour': \(\) => key && void triage\('snooze-hour', key\)/)
  assert.match(main, /'snooze-tomorrow': \(\) => key && void triage\('snooze-tomorrow', key\)/)
  assert.match(main, /return state\.focusNode \?\? \(state\.selected\?\.startsWith\('s:'\) \? state\.selected\.slice\(2\) : null\)/)
})

test('2.1.2: the card draws its actions in the title row, from cardModel, with no Open and no extra lines', () => {
  const main = page('card')
  const showCard = main.slice(main.indexOf('function showCard('), main.indexOf('function cardSpot('))
  assert.ok(showCard.includes('cardModel('), 'the card is built from cardModel')
  assert.ok(showCard.includes("el('div', { class: 'cx-card-head' }"), 'a title row')
  assert.ok(showCard.indexOf('cx-card-head') < showCard.indexOf('cardActions('), 'actions are built inside the title row')
  assert.ok(!showCard.includes('openInClaude'), 'no Open on the card')
  assert.ok(!showCard.includes('sessionName'), 'no sessionName lines')
})

test('2.1.2 review: the card uses the shared status dot, spaces its buttons and shows a tooltip only where text is cut', () => {
  const main = page('card')
  const css = read('../../companion/inbox/constellation.css')
  const showCard = main.slice(main.indexOf('function showCard('), main.indexOf('function cardSpot('))
  assert.ok(showCard.includes('class: `dot b-${bucket}`'), 'the shared .dot b-<bucket> (7 px, needs-you edge)')
  assert.doesNotMatch(css, /\.cx-card-status[^{]*\.dot/, 'no card-only dot styles')
  assert.doesNotMatch(/\.cx-card-actions \{[^}]*\}/.exec(css)?.[0] ?? '', /gap: 0;/, 'a gap between the action buttons')
  assert.doesNotMatch(showCard, /title: model\.(head\.title|status|body)/, 'no tooltip that repeats visible text')
  assert.ok(showCard.includes('titleIfClipped('), 'tooltips only for cut text')
})

test('2.1.2 review: reaching the card cancels a hide scheduled while crossing the map to it', () => {
  const main = page('stage-input')
  assert.match(main, /\$\('cx-card'\)\.addEventListener\('pointerenter', \(\) => clearTimeout\(cardTimer\)\)/)
})

test('2.1.2: the left-column row draws the same pieces as statusLine (state word, age, reason), so the card matches it', () => {
  const main = page('rail')
  const popout = read('../../shared/popout.js')
  const line = popout.slice(popout.indexOf('export function statusLine('), popout.indexOf('export function snapshotChanged('))
  assert.match(line, /rowMeta\(st\.bucket, st\.reason\)/)
  assert.match(line, /ago\(now - st\.since\)/)
  const rail = main.slice(main.indexOf('const meta = rowMeta(st.bucket, st.reason)'), main.indexOf('railRows.set('))
  assert.match(rail, /el\('span', \{ class: 'why' \}, meta\.before\),\s*st\.since \? ' ' : null,\s*el\('span', \{ class: 'age'[^\n]*ago\(Date\.now\(\) - st\.since\)[^\n]*\),\s*meta\.after,/)
})
