import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function sources(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(rel)
    return /\.(ts|tsx)$/.test(entry.name) ? [rel] : []
  })
}

test('every atom of a key declares the same shape tag in every file, the one src/state.ts exports (E-63)', () => {
  const state = fs.readFileSync(path.join(ROOT, 'src', 'state.ts'), 'utf8')
  const block = /export const SHAPES = \{([^}]*)\}/.exec(state)
  assert.ok(block, 'src/state.ts exports SHAPES')
  const expected = Object.fromEntries([...block[1].matchAll(/(\w+): '([^']+)'/g)].map(m => [m[1], m[2]]))
  const seen = []
  for (const file of [...sources('src'), ...sources('hooks')]) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    for (const m of text.matchAll(/atom\(\{ plugin: 'orbit', key: '(\w+)' \}[^\n]*?\{ shape: (?:'([^']+)'|SHAPES\.(\w+)) \}/g)) {
      const [, key, literal, named] = m
      seen.push(`${file}:${key}`)
      if (named) assert.equal(named, key, `${file}: the ${key} atom uses SHAPES.${named}`)
      else assert.equal(literal, expected[key], `${file}: the ${key} atom's shape '${literal}' differs from SHAPES.${key} '${expected[key]}'`)
    }
  }
  assert.ok(seen.length >= 5, `atoms found: ${seen.join(', ')}`)
})
