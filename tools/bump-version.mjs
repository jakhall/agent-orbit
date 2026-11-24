import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node tools/bump-version.mjs <major.minor.patch>')
  process.exit(1)
}

const targets = [
  { file: '../shared/constants.js', pattern: /MOD_VERSION = '(\d+\.\d+\.\d+)'/, text: `MOD_VERSION = '${version}'` },
  { file: '../.claude-plugin/plugin.json', pattern: /"version": "(\d+\.\d+\.\d+)"/, text: `"version": "${version}"` },
]

const edits = targets.map(({ file, pattern, text }) => {
  const path = fileURLToPath(new URL(file, import.meta.url))
  const raw = fs.readFileSync(path, 'utf8')
  const found = raw.match(pattern)
  if (!found) {
    console.error(`bump-version: no version found in ${file.slice(3)}`)
    process.exit(1)
  }
  return { path, name: file.slice(3), from: found[1], next: raw.replace(pattern, text) }
})

for (const { path, name, from, next } of edits) {
  fs.writeFileSync(path, next)
  console.log(`bump-version: ${name} ${from} -> ${version}`)
}
