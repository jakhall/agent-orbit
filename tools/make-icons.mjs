// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { PALETTE } from '../shared/constants.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'companion', 'icons')
export const SIZES = [16, 24, 32, 48, 256]

const USAGE = `node tools/make-icons.mjs [--preview <file.png>]

Writes companion/icons/: orbit.svg, orbit-16/32/48/256.png and favicon.ico,
all drawn from one shape list in PALETTE colours (plain Node, no browser).
--preview also writes a sheet: 16 and 32 at 1x and enlarged, and 256, on a
dark and a light ground.`

/**
 * @typedef {{ kind: 'rrect', size: number, r: number, fill: string }
 *   | { kind: 'polygon', points: number[][], fill: string, stroke: string, width: number }
 *   | { kind: 'circle', cx: number, cy: number, r: number, fill: string }
 *   | { kind: 'orbit', cx: number, cy: number, rx: number, ry: number, tilt: number, stroke: string, width: number, opacity: number, near: boolean }} Shape
 */

const hexagon = (cx, cy, r) =>
  [-90, -30, 30, 90, 150, 210].map(deg => {
    const a = (deg * Math.PI) / 180
    return [+(cx + r * Math.cos(a)).toFixed(2), +(cy + r * Math.sin(a)).toFixed(2)]
  })

/**
 * The Orbit mark on a 64-unit tile: a hexagon planet, a tilted orbit whose near
 * half passes in front of it, and a blue moon on the far side. Small sizes get
 * heavier strokes; at 16 px the orbit is dropped and the planet and moon grow.
 * @param {'full' | 'small' | 'tiny'} variant
 * @returns {Shape[]}
 */
export function iconShapes(variant) {
  const { surface, raised, text, accent } = PALETTE
  const tile = /** @type {Shape} */ ({ kind: 'rrect', size: 64, r: 14, fill: surface })
  if (variant === 'tiny') {
    return [tile, { kind: 'polygon', points: hexagon(28, 35, 18.5), fill: raised, stroke: text, width: 8 }, { kind: 'circle', cx: 52, cy: 13, r: 6.5, fill: accent }]
  }
  const small = variant === 'small'
  const width = small ? 3 : 2
  const orbit = { kind: 'orbit', cx: 32, cy: 31, rx: 25, ry: 10, tilt: -24 }
  const moon = small ? 5.4 : 4.8
  return [
    tile,
    /** @type {Shape} */ ({ ...orbit, stroke: accent, width, opacity: small ? 0.7 : 0.45, near: false }),
    { kind: 'polygon', points: hexagon(32, 34, small ? 13.86 : 13), fill: raised, stroke: text, width: small ? 4 : 3.4 },
    ...(small
      ? []
      : /** @type {Shape[]} */ ([
          { ...orbit, stroke: surface, width: width + 3, opacity: 1, near: true },
          { ...orbit, stroke: accent, width, opacity: 0.9, near: true },
        ])),
    { kind: 'circle', cx: 54.4, cy: 20.1, r: moon + 1.6, fill: surface },
    { kind: 'circle', cx: 54.4, cy: 20.1, r: moon, fill: accent },
  ]
}

export const variantFor = size => (size <= 16 ? 'tiny' : size <= 32 ? 'small' : 'full')

/** @param {Shape[]} shapes */
export function toSvg(shapes) {
  const parts = shapes.map(s => {
    if (s.kind === 'rrect') return `<rect width="${s.size}" height="${s.size}" rx="${s.r}" fill="${s.fill}"/>`
    if (s.kind === 'circle') return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${s.fill}"/>`
    if (s.kind === 'polygon') return `<polygon points="${s.points.map(p => p.join(',')).join(' ')}" fill="${s.fill}" stroke="${s.stroke}" stroke-width="${s.width}" stroke-linejoin="round"/>`
    const paint = `fill="none" stroke="${s.stroke}"${s.opacity < 1 ? ` stroke-opacity="${s.opacity}"` : ''} stroke-width="${s.width}" transform="rotate(${s.tilt} ${s.cx} ${s.cy})"`
    if (!s.near) return `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}" ${paint}/>`
    return `<path d="M${s.cx + s.rx} ${s.cy}A${s.rx} ${s.ry} 0 0 1 ${s.cx - s.rx} ${s.cy}" ${paint}/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${parts.join('')}</svg>`
}

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)

const segmentDistance = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

const insidePolygon = (px, py, points) => {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Distance from a point to the orbit's ellipse (first-order, exact enough for thin strokes); the near half ends square, so it joins the far half. */
const orbitDistance = (px, py, s) => {
  const a = (-s.tilt * Math.PI) / 180
  const x = (px - s.cx) * Math.cos(a) - (py - s.cy) * Math.sin(a)
  const y = (px - s.cx) * Math.sin(a) + (py - s.cy) * Math.cos(a)
  if (s.near && y < 0) return Infinity
  const f = (x * x) / (s.rx * s.rx) + (y * y) / (s.ry * s.ry) - 1
  const gx = (2 * x) / (s.rx * s.rx)
  const gy = (2 * y) / (s.ry * s.ry)
  return Math.abs(f) / Math.hypot(gx, gy)
}

/** @returns {[number[], number][]} each layer as [rgb, alpha] at this point, in paint order */
const paintsAt = (px, py, shapes) => {
  const out = []
  for (const s of shapes) {
    if (s.kind === 'rrect') {
      const qx = Math.max(Math.abs(px - s.size / 2) - (s.size / 2 - s.r), 0)
      const qy = Math.max(Math.abs(py - s.size / 2) - (s.size / 2 - s.r), 0)
      if (px >= 0 && py >= 0 && px <= s.size && py <= s.size && Math.hypot(qx, qy) <= s.r) out.push([rgb(s.fill), 1])
    } else if (s.kind === 'circle') {
      if (Math.hypot(px - s.cx, py - s.cy) <= s.r) out.push([rgb(s.fill), 1])
    } else if (s.kind === 'polygon') {
      if (insidePolygon(px, py, s.points)) out.push([rgb(s.fill), 1])
      let d = Infinity
      for (let i = 0; i < s.points.length; i += 1) d = Math.min(d, segmentDistance(px, py, s.points[i], s.points[(i + 1) % s.points.length]))
      if (d <= s.width / 2) out.push([rgb(s.stroke), 1])
    } else if (orbitDistance(px, py, s) <= s.width / 2) out.push([rgb(s.stroke), s.opacity])
  }
  return out
}

/**
 * Rasterises shapes at `size` px by supersampling, each sample composited
 * source-over on transparent, then averaged (premultiplied).
 * @param {Shape[]} shapes
 * @param {number} size
 * @returns {Uint8Array} straight RGBA
 */
export function rasterise(shapes, size, samples = size <= 48 ? 16 : 6) {
  const pixels = new Uint8Array(size * size * 4)
  const unit = 64 / size
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          let cr = 0
          let cg = 0
          let cb = 0
          let ca = 0
          for (const [[lr, lg, lb], la] of paintsAt((x + (sx + 0.5) / samples) * unit, (y + (sy + 0.5) / samples) * unit, shapes)) {
            cr = lr * la + cr * (1 - la)
            cg = lg * la + cg * (1 - la)
            cb = lb * la + cb * (1 - la)
            ca = la + ca * (1 - la)
          }
          r += cr
          g += cg
          b += cb
          a += ca
        }
      }
      const n = samples * samples
      const i = (y * size + x) * 4
      pixels[i + 3] = Math.round((a / n) * 255)
      if (a > 0) {
        pixels[i] = Math.round((r / a) * 255)
        pixels[i + 1] = Math.round((g / a) * 255)
        pixels[i + 2] = Math.round((b / a) * 255)
      }
    }
  }
  return pixels
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = bytes => {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** @param {Uint8Array} rgba @param {number} width @param {number} height */
export function encodePng(rgba, width, height = width) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const rows = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y += 1) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** An ICO whose images are PNGs (Vista and later). @param {Buffer[]} pngs */
export function icoFrom(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  let offset = header.length
  pngs.forEach((png, i) => {
    const entry = 6 + i * 16
    const size = png.readUInt32BE(16)
    header[entry] = size >= 256 ? 0 : size
    header[entry + 1] = size >= 256 ? 0 : size
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...pngs])
}

/** A review sheet: 16 and 32 at 1x and enlarged 8x/4x, and 256, on a dark then a light ground. */
function previewSheet(images) {
  const half = 600
  const width = half * 2
  const height = 300
  const sheet = new Uint8Array(width * height * 4)
  const grounds = [rgb('#202020'), rgb('#F3F3F3')]
  const put = (x0, y0, image, size, scale, ground) => {
    for (let y = 0; y < size * scale; y += 1) {
      for (let x = 0; x < size * scale; x += 1) {
        const s = (Math.floor(y / scale) * size + Math.floor(x / scale)) * 4
        const d = ((y0 + y) * width + x0 + x) * 4
        const alpha = image[s + 3] / 255
        for (let c = 0; c < 3; c += 1) sheet[d + c] = Math.round(image[s + c] * alpha + ground[c] * 255 * (1 - alpha))
      }
    }
  }
  grounds.forEach((ground, i) => {
    const x0 = i * half
    for (let y = 0; y < height; y += 1) {
      for (let x = x0; x < x0 + half; x += 1) {
        const d = (y * width + x) * 4
        sheet.set([...ground.map(c => Math.round(c * 255)), 255], d)
      }
    }
    put(x0 + 20, 22, images[16], 16, 1, ground)
    put(x0 + 20, 54, images[32], 32, 1, ground)
    put(x0 + 20, 110, images[16], 16, 8, ground)
    put(x0 + 168, 110, images[32], 32, 4, ground)
    put(x0 + 320, 22, images[256], 256, 1, ground)
  })
  return encodePng(sheet, width, height)
}

function main(argv) {
  if (argv.includes('--help')) return console.log(USAGE)
  const preview = argv.includes('--preview') ? argv[argv.indexOf('--preview') + 1] : null
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'orbit.svg'), `${toSvg(iconShapes('full'))}\n`)
  const images = Object.fromEntries(SIZES.map(size => [size, rasterise(iconShapes(variantFor(size)), size)]))
  const pngs = SIZES.map(size => encodePng(images[size], size))
  SIZES.forEach((size, i) => fs.writeFileSync(path.join(OUT, `orbit-${size}.png`), pngs[i]))
  fs.writeFileSync(path.join(OUT, 'favicon.ico'), icoFrom(pngs))
  console.log(`icons: wrote orbit.svg, ${SIZES.map(s => `orbit-${s}.png`).join(', ')} and favicon.ico in ${path.relative(ROOT, OUT)}`)
  if (preview) {
    fs.writeFileSync(preview, previewSheet(images))
    console.log(`icons: preview ${preview}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
