import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { hexagonPoints } from '../../shared/map.js'

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
const minimapSource = () => {
  const main = read('../../companion/inbox/stage.js')
  return main.slice(main.indexOf('function renderMinimap('), main.indexOf('function renderMinimapRect('))
}

test('2.1.2: hexagonPoints is shared with the page, centred on the origin', () => {
  const points = hexagonPoints(4).split(' ').map(p => p.split(',').map(Number))
  assert.equal(points.length, 6)
  for (const [x, y] of points) assert.ok(Math.abs(Math.hypot(x, y) - 4) < 0.05)
})

test('2.1.2: the minimap draws projects as hub hexagons, not 2.0 cluster rings', () => {
  const src = minimapSource()
  assert.ok(src.includes('hexagonPoints('), 'a hexagon per project')
  assert.match(src, /hexagonPoints\(MINIMAP_HUB_R\)[^\n]*fill="var\(--bg2\)" stroke="var\(--control-edge\)"/, 'hub edges in control-edge so they read at 1x in the light theme')
  assert.doesNotMatch(src, /Math\.hypot\(m\.x - p\.x/, 'no ring sized to the cluster')
  assert.doesNotMatch(src, /fill="none" stroke="var\(--dim\)"/, 'no 2.0 ring')
})

test('2.1.2: the minimap insets the map by at least a hub, so edge hubs are not clipped, and the rect and clicks use the same frame', () => {
  const main = read('../../companion/inbox/stage.js')
  const pad = Number(/MINIMAP_PAD = (\d+)/.exec(main)?.[1])
  const hub = Number(/MINIMAP_HUB_R = (\d+)/.exec(main)?.[1])
  assert.ok(pad >= hub + 1, `pad ${pad} clears a hub of ${hub}`)
  assert.ok(minimapSource().includes('minimapModel = minimapFrame('), 'the drawing uses the inset frame')
  const rect = main.slice(main.indexOf('function renderMinimapRect('), main.indexOf('function renderMap('))
  assert.ok(rect.includes('minimapFrame(') && !rect.includes('minimapView('), 'the view rect uses the inset frame')
  assert.match(read('../../companion/inbox/stage-input.js'), /minimapModel\.toWorld\(/,'clicks map back through the same model')
})

test('2.1.2: the minimap draws spokes and session dots under the hubs, with needs-you on top in amber', () => {
  const src = minimapSource()
  const spokes = src.indexOf('<line')
  const hubs = src.indexOf('hexagonPoints(')
  const dots = src.indexOf('var(--dim)')
  const amber = src.indexOf('var(--amber)')
  const view = src.indexOf('cx-minimap-view')
  assert.ok(spokes > -1 && dots > -1 && amber > -1 && view > -1, 'spokes, neutral dots, amber dots and the view rect')
  assert.ok(spokes < hubs && hubs < dots && view < amber && dots < amber, 'drawn in order: spokes, hubs, dots, the view rect, needs-you last')
})
