import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { lightThemeCss } from '../shared/render.js'

const file = fileURLToPath(new URL('../companion/inbox.html', import.meta.url))
const raw = fs.readFileSync(file, 'utf8')
const pattern = /<style id="theme-light">[^<]*<\/style>/
if (!pattern.test(raw)) {
  console.error('sync-light-theme: no <style id="theme-light"> in companion/inbox.html')
  process.exit(1)
}
const next = raw.replace(pattern, () => `<style id="theme-light">${lightThemeCss()}</style>`)
if (next === raw) {
  console.log('sync-light-theme: already in sync')
} else {
  fs.writeFileSync(file, next)
  console.log('sync-light-theme: companion/inbox.html updated from PALETTE_LIGHT')
}
