import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { PALETTE } from '../../shared/constants.js'

const file = relative => new URL(relative, import.meta.url)
const read = relative => fs.readFileSync(file(relative), 'utf8')
const PNG_SIGNATURE = '89504e470d0a1a0a'
const SIZES = [16, 24, 32, 48, 256]

const pngSize = bytes => {
  assert.equal(bytes.subarray(0, 8).toString('hex'), PNG_SIGNATURE, 'a PNG')
  assert.equal(bytes.subarray(12, 16).toString('latin1'), 'IHDR')
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}

test('app icon: the SVG is the Orbit mark in palette colours, with no script or outside reference', () => {
  const svg = read('../../companion/icons/orbit.svg')
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64"/)
  for (const colour of [PALETTE.surface, PALETTE.raised, PALETTE.text, PALETTE.accent]) assert.ok(svg.includes(colour), `uses ${colour}`)
  assert.doesNotMatch(svg, /<script|on[a-z]+=|href=|url\(/i)
})

test('app icon: one PNG per size, each the size its name says', () => {
  for (const size of SIZES) assert.deepEqual(pngSize(fs.readFileSync(file(`../../companion/icons/orbit-${size}.png`))), [size, size], `orbit-${size}.png`)
})

test('app icon: favicon.ico holds the 16, 24, 32, 48 and 256 PNGs', () => {
  const ico = fs.readFileSync(file('../../companion/icons/favicon.ico'))
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, SIZES.length], 'an icon with one image per size')
  const sizes = []
  for (let i = 0; i < SIZES.length; i += 1) {
    const entry = 6 + i * 16
    const length = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    const image = ico.subarray(offset, offset + length)
    const [w, h] = pngSize(image)
    assert.equal(ico[entry] || 256, w)
    assert.equal(ico[entry + 1] || 256, h)
    assert.deepEqual(image, fs.readFileSync(file(`../../companion/icons/orbit-${w}.png`)), `the ICO's ${w} px image is orbit-${w}.png`)
    sizes.push(w)
  }
  assert.deepEqual(sizes, SIZES)
})

test('app icon: the page links every PNG size but not the SVG (browsers prefer an SVG over the drawn small sizes), and the server no longer answers the favicon with nothing', () => {
  const html = read('../../companion/inbox.html')
  assert.doesNotMatch(html, /orbit\.svg/)
  for (const size of SIZES) assert.match(html, new RegExp(`<link rel="icon" type="image/png" sizes="${size}x${size}" href="/icons/orbit-${size}\\.png" />`))
  const server = read('../../companion/lib/routes/pages.mjs')
  assert.doesNotMatch(server, /'\/favicon\.ico'\) return send\(res, 204/)
  assert.match(server, /const ICON_FILES = \{/)
})
