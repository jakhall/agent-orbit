import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
const rule = (css, selector) => {
  const at = css.indexOf(`\n${selector} {`)
  assert.ok(at >= 0, `${selector} has a rule`)
  return css.slice(at, css.indexOf('}', at))
}

test('2.1.2 meters: the page draws 2.0 usage meters (dot, text, neutral bar), not the "Limits" text line', () => {
  const header = read('../../companion/inbox/header.js')
  const render = header.slice(header.indexOf('function renderLimits()'), header.indexOf('const SHELL_WORD'))
  assert.match(render, /headerMeters\(usageView\(\), false\)/)
  assert.doesNotMatch(render, /'Limits '|class: 'lead'|', '/, 'no text line')
  assert.match(render, /el\('span', \{ class: 'dot' \}\)/)
  assert.match(render, /el\('span', \{ class: 't' \}, m\.text/)
  assert.match(render, /el\('span', \{ class: 'bar' \}, el\('span', \{ style: `width:\$\{Math\.min\(100, Math\.max\(0, m\.percent\)\)\}%` \}\)\)/)
  assert.match(read('../../companion/inbox/main.js'), /\$\('cx-limits'\)\.addEventListener\('click', \(\) => openSettings\('cx-s-usage'\)\)/)
})

test('2.1.2 meters: status colour only in the dot; the bars stay neutral; old readings muted', () => {
  const css = read('../../companion/inbox/constellation.css')
  assert.match(rule(css, '.cx-meter .bar'), /background: var\(--line-strong\)/)
  assert.match(rule(css, '.cx-meter .bar > span'), /background: var\(--text\)/)
  assert.match(rule(css, '.cx-meter.is-high .dot'), /background: var\(--amber\)/)
  assert.match(rule(css, '.cx-meter.is-critical .dot'), /background: var\(--coral\)/)
  assert.match(rule(css, '.cx-meter.is-stale .bar > span'), /background: var\(--dim\)/)
  assert.match(rule(css, '.cx-meter .dot'), /background: none/, 'no dot below 80% (base.css gives every .dot a grey fill)')
  for (const block of css.match(/\.cx-meter[^{]*\{[^}]*\}/g) ?? []) {
    if (/\.dot\s*\{/.test(block)) continue
    assert.doesNotMatch(block, /--(amber|coral|green|accent)\b/, `no status colour outside the dot: ${block.split('{')[0].trim()}`)
  }
})

test('2.1.6 meters: they sit at the right of the footer in place of the key hints, one row each, never hidden', () => {
  const html = read('../../companion/inbox.html')
  const footer = html.slice(html.indexOf('<footer class="cx-status">'), html.indexOf('</footer>'))
  assert.match(footer, /<button id="cx-limits" type="button" class="cx-limits" hidden><\/button>/)
  assert.doesNotMatch(html, /cx-keys/, 'key hints gone')
  assert.doesNotMatch(html.slice(html.indexOf('<header'), html.indexOf('</header>')), /cx-limits/, 'not in the header')
  const css = read('../../companion/inbox/constellation.css')
  assert.match(rule(css, '.cx-limits'), /margin: -2px -6px -2px auto/)
  assert.match(rule(css, '.cx-meter'), /grid-template-columns: 6px auto 40px/)
  assert.match(rule(css, '.cx-meter .bar'), /grid-row: 1;\s*grid-column: 3/)
  for (const query of css.match(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g) ?? []) {
    assert.doesNotMatch(query, /\.cx-limits[^{]*\{[^}]*display: none/, `meters never hidden: ${query.split('{')[0].trim()}`)
  }
})
