import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SINGLES = [0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x180e, 0x2028, 0x2029, 0x2800, 0x3164, 0xfeff, 0xffa0]
const RANGES = [[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfe00, 0xfe0f]]
const isInvisible = cp => SINGLES.includes(cp) || RANGES.some(([a, b]) => cp >= a && cp <= b)
const SOURCE = /\.(m?js|tsx?|json|html|css|ps1)$/
const SKIPPED = new Set(['.git', 'node_modules', '.agents'])

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(file)
    else if (SOURCE.test(entry.name)) yield file
  }
}

test('no source file types an invisible or format character; tests build them from code points (E-27)', () => {
  const found = []
  for (const file of sourceFiles(ROOT)) {
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const ch of line) if (isInvisible(ch.codePointAt(0))) found.push(`${path.relative(ROOT, file)}:${i + 1} U+${ch.codePointAt(0).toString(16).toUpperCase()}`)
      })
  }
  assert.deepEqual(found, [])
})
