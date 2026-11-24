import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT_FILTERS, DEFAULT_SETTINGS } from '../shared/constants.js'
import { defaultPrefs } from '../src/core/prefs'
import { bucketed, NOW } from './fixtures'

declare const console: { log: (...args: unknown[]) => void }
type TestEngine = import('claude-code/testing').Engine

const DATA = 'C:\\Users\\t\\.claude\\orbit'
function host(on: On, store: Map<string, string>) {
  const writes: { path: string; text: string }[] = []
  const pathOf = (e: unknown) => (e as { path: string }).path
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', USERPROFILE: 'C:\\Users\\t', APPDATA: 'C:\\Users\\t\\AppData\\Roaming', SystemRoot: 'C:\\Windows' })
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'cli-9' }) as never)
  on('session.model', () => ({ value: null }) as never)
  on('session.version', () => ({ value: { version: '2.1.321' } }) as never)
  on('session.repo', () => ({ value: null }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('command.register', (_, e) => ({ value: { command: (e as unknown as { name: string }).name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [{ id: 'orbit', isShown: true, isPlaced: true }] }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', (_, e) => ({ value: store.has(pathOf(e)) }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('fs.write', (_, e) => {
    const w = e as unknown as { path: string; text: string }
    writes.push(w)
    store.set(w.path, w.text)
    return { value: undefined } as never
  })
  on('fs.read', (_, e) => {
    const text = store.get(pathOf(e))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.stat', (_, e) => {
    const text = store.get(pathOf(e))
    if (text === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: text.length, mtimeMs: NOW, isLink: false } } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { writes, clock }
}

/** Draws the pane `runs` times in `view` (a new width each time, so no draw is a cached one) and returns the wall time of each mount. */
async function draws($: TestEngine, view: string, runs: number, from = 0): Promise<number[]> {
  const times: number[] = []
  for (let i = 0; i < runs; i += 1) {
    const props = { title: 'Orbit', isFocused: false, bodyColumns: 60 + from + i, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
    const started = Date.now()
    const ui = await $.ui.mount({ plugin: 'orbit', component: 'Pane', requestId: 'orbit', props, surface: 'desktop' } as never)
    times.push(Date.now() - started)
    if (i === 0 && view !== 'list') {
      await ui.press({ key: `view-${view}` })
    }
    await ui.unmount()
  }
  return times
}

/** The target is 20 ms, measured with this file alone (BENCH lines); the gate runs every kit file at once, so it guards only against a large regression. */
const LOADED_GUARD_MS = 60
/**
 * Measured draws per view, after one warm-up draw left out of the average (a
 * fresh plugin's first draw is the cold, slow one). Each view is its own test,
 * so the kit's 5 s limit covers one plugin start (about 0.75 s alone), these
 * draws and two 130 s clock advances.
 */
const DRAWS = 3

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0

/** Starts the plugin on a 50-session snapshot, draws the pane once to warm up and `DRAWS` more times in `view`, and returns the measured draws' share of the pane stats the session published. */
async function bench($: TestEngine, on: On, view: 'list' | 'graph') {
  const prefs = { ...defaultPrefs(), updatedAt: 1, settings: { ...DEFAULT_SETTINGS }, filters: { ...DEFAULT_FILTERS } }
  const store = new Map<string, string>([
    [`${DATA}\\snapshot-v2.json`, JSON.stringify(bucketed(50, 10))],
    [`${DATA}\\prefs.json`, JSON.stringify(prefs)],
  ])
  const { writes, clock } = host(on, store)
  await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
  for (let i = 0; i < 2_000; i += 1) await Promise.resolve()
  await clock.advance(4_000)
  const published = async () => {
    await clock.advance(130_000)
    return writes
      .filter(w => w.path.endsWith('sessions\\cli-9.json'))
      .map(w => JSON.parse(w.text) as { pane?: { renders: number; avgMs: number; maxMs: number; svgChars: number } })
      .at(-1)?.pane ?? { renders: 0, avgMs: 0, maxMs: 0, svgChars: 0 }
  }
  await draws($, view, 1)
  const warm = await published()
  const walls = await draws($, 'list', DRAWS, 1)
  const after = await published()
  const renders = after.renders - warm.renders
  const avgMs = renders > 0 ? Math.round((after.avgMs * after.renders - warm.avgMs * warm.renders) / renders) : 0
  console.log(`BENCH C10 pane ${view}, 50 sessions, own stats: ${renders} draws after a warm-up, avg ~${avgMs} ms (warm-up avg ${warm.avgMs} ms over ${warm.renders}), max of all ${after.maxMs} ms, svg ${after.svgChars} chars; mount wall median ${median(walls)} ms`)
  return { renders, avgMs }
}

test('bench C10: the pane draws its list of a 50-session snapshot well within its budget (its own render stats; 20 ms target measured alone)', async ($, on) => {
  const pane = await bench($, on, 'list')
  expect(pane.renders).toBeGreaterThanOrEqual(DRAWS)
  expect(pane.avgMs).toBeLessThan(LOADED_GUARD_MS)
})

test('bench C10: the pane draws its graph of a 50-session snapshot well within its budget (its own render stats; 20 ms target measured alone)', async ($, on) => {
  const pane = await bench($, on, 'graph')
  expect(pane.renders).toBeGreaterThanOrEqual(DRAWS)
  expect(pane.avgMs).toBeLessThan(LOADED_GUARD_MS)
})
