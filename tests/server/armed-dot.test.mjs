import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
const page = name => read(`../../companion/inbox/${name}.js`)
const pageModules = () => fs.readdirSync(new URL('../../companion/inbox/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `../../companion/inbox/${f}`)

test('2.1.2 A5: the header has no armed text or chips; the page, its script and its styles drop them', () => {
  assert.doesNotMatch(read('../../companion/inbox.html'), /cx-armed/)
  for (const file of pageModules()) assert.doesNotMatch(read(file), /cx-armed|cx-chip|ARMED_LEAD|Remote on:/, file)
  for (const file of ['../../companion/inbox/constellation.css', '../../companion/inbox/sheets.css']) {
    assert.doesNotMatch(read(file), /cx-armed|cx-chip/, file)
  }
})

test('2.1.2 A5: while anything is armed the Settings button carries a dot and names what is on; a click opens Settings at the first armed switch', () => {
  const live = page('live')
  const render = live.slice(live.indexOf('function renderArmed()'), live.indexOf('async function pollHealth()'))
  assert.match(render, /armedCapabilities\(/)
  assert.match(render, /settingsName\(chips\)/)
  assert.match(render, /setAttribute\('aria-label', name\)/)
  assert.match(render, /\.title = name/)
  assert.match(render, /classList\.toggle\('is-armed', chips\.length > 0\)/)
  assert.match(render, /cx-s-arm-\$\{chips\[0\]\.key\}/)
  assert.match(page('main'), /\$\('cx-settings-open'\)\.addEventListener\('click', \(\) => openSettings\(\$\('cx-settings-open'\)\.dataset\.armedFocus \|\| null\)\)/)
  const css = read('../../companion/inbox/constellation.css')
  const dot = css.slice(css.indexOf('#cx-settings-open.is-armed::after'))
  assert.ok(css.includes('#cx-settings-open.is-armed::after'), 'the dot is drawn on the armed Settings button')
  assert.match(dot.slice(0, dot.indexOf('}')), /background: var\(--accent\)/)
  assert.doesNotMatch(css, /#cx-settings-open[^{]*\{[^}]*display: none/, 'the button never hides at any width')
})
