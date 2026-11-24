import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SessionView } from '../types'
import { DEFAULT_FILTERS, DEFAULT_SETTINGS } from '../shared/constants.js'
import { ago, isViewersAgent } from '../shared/format.js'
import { KEY_MAP, snoozeUntil } from '../shared/popout.js'
import { defaultPrefs } from '../src/core/prefs'
import { INITIAL_UI } from '../src/state'
type TestEngine = import('claude-code/testing').Engine
import { agent, bucketed, buildSnapshot, NOW, session } from './fixtures'

const PANE = {
  plugin: 'orbit',
  component: 'Pane',
  requestId: 'orbit',
  props: {
    title: 'Orbit',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const REG_OUTPUT = '    (Default)    REG_SZ    "C:\\Apps\\Claude.exe" "%1"'
const KEY = 'local_0a1b2c3d-0000-4000-8000-000000000001'

const status = (bucket: string, reason: string, since: number) => ({ status: { bucket, reason, since, isObserved: true } }) as Partial<SessionView>

const SNAPSHOT = buildSnapshot(
  [
    session(KEY, { title: 'Implement OAuth login', lifecycle: 'running', phase: 'implementing', activity: 'Editing auth.ts', ...status('working', 'Editing auth.ts', NOW - 60_000) }),
    session('local_0a1b2c3d-0000-4000-8000-000000000002', { title: 'Fix flaky tests', lifecycle: 'waiting-user', attention: 'question', attentionText: 'Asked you a question', ...status('needs-you', 'Asked you a question', NOW - 5 * 60_000) }),
    session('cli:term-1', { title: 'repo (terminal)', environment: 'terminal', canOpen: false, localId: null }),
  ],
  [agent(KEY, 'a1', { description: 'Research auth libraries' })],
)

type Ui = Record<string, unknown>

const started = new WeakSet<object>()

/** Starts this test's session once (the mod then reads the seeded `snapshot-v2.json`) and mounts the pane. */
async function mountPane($: TestEngine, props: Parameters<TestEngine['ui']['mount']>[0]) {
  if (!started.has($)) {
    started.add($)
    await $.session.start({ cwd: 'C:\\repo', surface: 'desktop', isInteractive: false })
    for (let i = 0; i < 2_000; i += 1) await Promise.resolve()
  }
  return $.ui.mount(props)
}

const SNAPSHOT_FILE = 'C:\\Users\\t\\.claude\\orbit\\snapshot-v2.json'
const PREFS_FILE = 'C:\\Users\\t\\.claude\\orbit\\prefs.json'
const folders: string[] = []

async function seed($: TestEngine, on: On, values: { ui?: Ui; settings?: Partial<typeof DEFAULT_SETTINGS>; filters?: Partial<typeof DEFAULT_FILTERS>; snapshot?: unknown }) {
  const writes: string[] = []
  const prefs = { ...defaultPrefs(), updatedAt: 1, settings: { ...DEFAULT_SETTINGS, ...(values.settings ?? {}) }, filters: { ...DEFAULT_FILTERS, ...(values.filters ?? {}) } }
  const ui = { ...INITIAL_UI, ...(values.ui ?? {}) }
  const seeds = new Map<string, unknown>([
    ['prefs', { shape: 'prefs-3', value: prefs }],
    ['ui', { shape: 'ui-2', value: ui }],
  ])
  on('state.get', async (_, e, next) => {
    const read = (await next(e)) as unknown as { value?: { version?: number } }
    const seeded = seeds.get((e as unknown as { key: string }).key)
    if (read?.value?.version || seeded === undefined) return read as never
    return { value: { value: seeded, version: 0 } } as never
  })
  const files = new Map<string, string>([
    [SNAPSHOT_FILE, JSON.stringify(values.snapshot ?? SNAPSHOT)],
    [PREFS_FILE, JSON.stringify(prefs)],
  ])
  folders.length = 0
  on('fs.read', (_, e) => {
    const text = files.get((e as unknown as { path: string }).path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.stat', (_, e) => {
    const path = (e as unknown as { path: string }).path
    if (folders.includes(path)) return { value: { kind: 'dir', size: 0, mtimeMs: NOW, isLink: false } } as never
    const text = files.get(path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: text.length, mtimeMs: NOW - 60_000, isLink: false } } as never
  })
  on('fs.write', (_, e) => {
    const w = e as unknown as { path: string; text: string }
    writes.push(w.path)
    files.set(w.path, w.text)
    return { value: undefined } as never
  })
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:\\Users\\t', APPDATA: 'C:\\Users\\t\\AppData\\Roaming', SystemRoot: 'C:\\Windows' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'cli-pane' }) as never)
  on('fs.exists', () => ({ value: false }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  return { writes, clock, prefsNow: () => JSON.parse(files.get(PREFS_FILE) ?? '{}') as { done?: Record<string, number>; snoozed?: Record<string, { until: number; at: number }>; hidden?: Record<string, number> } }
}

test('a session row still opens its desktop session through the deep link (POC behaviour)', async ($, on) => {
  await seed($, on, {})
  const calls: (readonly string[])[] = []
  on('process.run', (_, e) => {
    calls.push(e.argv)
    const stdout = e.argv[0]?.endsWith('reg.exe') ? REG_OUTPUT : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Implement OAuth login/ }))?.text).toContain('Implement OAuth login')
  await ui.press({ key: KEY })
  expect(calls.at(-1)).toEqual(['C:\\Apps\\Claude.exe', `claude://claude.ai/epitaxy/${KEY}`])
  expect(calls.find(c => c[0]?.endsWith('reg.exe'))?.[0]).toBe('C:\\Windows\\System32\\reg.exe')
  await ui.unmount()
})

test('the list shows attention first and works on the terminal too', async ($, on) => {
  await seed($, on, {})
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await mountPane($, { ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Needs you · 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Fix flaky tests/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /terminal, view-only/ })).toBeDefined()
    await ui.unmount()
  }
})

test('Details opens the session drill-down with its id, model and evidence', async ($, on) => {
  await seed($, on, {})
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  await ui.press({ key: `d:${KEY}` })
  expect(await ui.find({ type: 'Text', text: /claude-opus-5-5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /observed from desktop session record/ })).toBeUndefined()
  await ui.press({ key: 'f-more' })
  expect(await ui.find({ type: 'Text', text: new RegExp(KEY) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /observed from desktop session record/ })).toBeDefined()
  expect(await ui.find({ key: 'detail-open' })).toBeDefined()
  expect(await ui.find({ key: `ag:${KEY}/a1` })).toBeUndefined()
  await ui.press({ key: 'sec-subagents' })
  await ui.press({ key: `ag:${KEY}/a1` })
  expect(await ui.find({ type: 'Text', text: /Research auth libraries/ })).toBeDefined()
  expect(await ui.find({ key: 'agent-parent' })).toBeDefined()
  await ui.unmount()
})

test('the constellation draws an Svg on desktop and explains itself on the terminal', async ($, on) => {
  await seed($, on, { ui: { view: 'graph' } })
  const desk = await mountPane($, { ...PANE, surface: 'desktop' })
  const svg = await desk.find({ type: 'Svg' })
  expect(svg).toBeDefined()
  await desk.press({ key: 'zoom-in' })
  await desk.press({ key: 'fit' })
  await desk.unmount()
  const term = await mountPane($, { ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /needs the desktop app/ })).toBeDefined()
  await term.unmount()
})

test('picking a node in Inspect shows its card', async ($, on) => {
  await seed($, on, { ui: { view: 'graph' } })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'card-open' })).toBeUndefined()
  await ui.select({ key: 'inspect', value: `s:${KEY}` })
  expect(await ui.find({ key: 'card-open' })).toBeDefined()
  await ui.unmount()
})

test('X-2: the pane has no message box and never sends to a session; replies go from the pop-out', async ($, on) => {
  await seed($, on, { ui: { view: 'detail', selected: `s:${KEY}` } })
  const sent: unknown[] = []
  on('session.send', (_, e) => {
    sent.push(e)
    return { isDelivered: true }
  })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Implement OAuth login/ })).toBeDefined()
  expect(await ui.find({ key: 'msg' })).toBeUndefined()
  expect(await ui.find({ key: 'msg-send' })).toBeUndefined()
  expect(sent.length).toBe(0)
  await ui.unmount()
})

test('a settings toggle takes effect at once', async ($, on) => {
  await seed($, on, { ui: { view: 'settings' } })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 's-simple' }))?.text).toBe('Simplified graph: off')
  await ui.press({ key: 's-simple' })
  expect((await ui.find({ key: 's-simple' }))?.text).toBe('Simplified graph: on')
  await ui.unmount()
})

function recordLaunches(on: On, dirs: string[]) {
  const calls: (readonly string[])[] = []
  on('process.run', (_, e) => {
    calls.push(e.argv)
    const stdout = e.argv[0]?.endsWith('reg.exe') ? REG_OUTPUT : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  folders.push(...dirs)
  return calls
}

test('New session opens the documented claude://code/new link with the folder and prompt, and nothing else', async ($, on) => {
  await seed($, on, {})
  const calls = recordLaunches(on, ['C:\\repo\\app'])
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  await ui.press({ key: 'view-new' })
  expect(await ui.find({ type: 'Text', text: /Nothing is sent until you press Enter/ })).toBeDefined()
  await ui.input({ key: 'new-folder-1', text: 'C:/repo/app/', kind: 'change' })
  await ui.input({ key: 'new-prompt-1', text: 'Fix the login bug', kind: 'change' })
  await ui.press({ key: 'new-start' })
  const launches = calls.filter(argv => argv.some(a => a.startsWith('claude://')))
  expect(launches).toEqual([['C:\\Apps\\Claude.exe', 'claude://code/new?folder=C%3A%5Crepo%5Capp&q=Fix%20the%20login%20bug']])
  expect(await ui.find({ type: 'Text', text: /Press Enter there to send/ })).toBeDefined()
  await ui.unmount()
})

test('New session refuses a relative or missing folder without launching anything', async ($, on) => {
  await seed($, on, {})
  const calls = recordLaunches(on, [])
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  await ui.press({ key: 'view-new' })
  await ui.input({ key: 'new-folder-1', text: 'repo\\app', kind: 'change' })
  await ui.input({ key: 'new-prompt-1', text: 'Keep this draft', kind: 'change' })
  await ui.press({ key: 'new-start' })
  expect(await ui.find({ type: 'Text', text: /Enter an absolute local folder/ })).toBeDefined()
  expect((await ui.find({ key: 'new-folder-2' }))?.text).toBe('repo\\app')
  expect((await ui.find({ key: 'new-prompt-2' }))?.text).toBe('Keep this draft')
  await ui.input({ key: 'new-folder-2', text: 'C:\\nowhere', kind: 'change' })
  await ui.press({ key: 'new-start' })
  expect(await ui.find({ type: 'Text', text: /No folder at C:/ })).toBeDefined()
  expect(calls.some(argv => argv.some(a => a.startsWith('claude://')))).toBe(false)
  await ui.unmount()
})

test("a project's detail offers New session here with its root filled in", async ($, on) => {
  await seed($, on, { ui: { view: 'detail', selected: 'p:c:\\repo\\app' } })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  await ui.press({ key: 'p-new' })
  const field = await ui.find({ key: 'new-folder-1' })
  expect(JSON.stringify(field)).toContain('c:\\\\repo\\\\app')
  await ui.unmount()
})

test('C10: pinning a session is a named toggle, and its queue row says Pinned (the queue has no Pinned group, as on the page)', async ($, on) => {
  await seed($, on, { ui: { view: 'detail', selected: 's:cli:term-1' } })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'detail-pin' }))?.text).toBe('Pin')
  await ui.press({ key: 'detail-pin' })
  expect((await ui.find({ key: 'detail-pin' }))?.text).toBe('Unpin')
  await ui.press({ key: 'view-list' })
  expect(await ui.find({ type: 'Text', text: /Pinned · / })).toBeUndefined()
  expect((await ui.find({ key: 'cli:term-1' }))?.text).toContain('Pinned')
  await ui.unmount()
})

const QUEUE_ORDER = ['Needs you', 'Failed', 'Ready for review', 'Working', 'Idle']
const FIRST = (i: number) => `local_${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`

test('C10: the list is the page queue: buckets in the page order, the longest-waiting need first, each row with its reason and age', async ($, on) => {
  await seed($, on, { snapshot: bucketed(12, 3) })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  const headings = (await ui.findAll({ type: 'Text', text: /^[A-Z][a-z ]+ · \d+$/ })).map(h => h.text.replace(/ · \d+$/, ''))
  expect(headings).toEqual(QUEUE_ORDER)
  const rows = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('local_'))
  expect(rows.slice(0, 2).map(r => r.key)).toEqual([FIRST(6), FIRST(0)])
  expect(rows[0]?.text).toContain('Asked you a question')
  expect(rows[0]?.text).toContain(ago(7 * 30_000))
  const failed = rows.find(r => r.key === FIRST(4))
  expect(failed?.text).toContain('Failed: tool error')
  expect(failed?.text).toContain(ago(5 * 30_000))
  expect(await ui.find({ type: 'Text', text: /2 need you · 2 working/ })).toBeDefined()
  await ui.unmount()
})

test('C10 review A1/A2/A4: a row dot is its bucket colour, the meta line keeps its spacing, and the card age is the row age', async ($, on) => {
  await seed($, on, { snapshot: bucketed(12, 3) })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  const rows = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('local_'))
  const dot = (key: string) => JSON.stringify(rows.find(r => r.key === key)).match(/"color":"(\w+)"[^}]*\},"children":\["●/)?.[1]
  expect(dot(FIRST(0))).toBe('warning')
  expect(dot(FIRST(4))).toBe('error')
  expect(dot(FIRST(2))).toBe('success')
  expect(dot(FIRST(1))).toBe('suggestion')
  expect(dot(FIRST(3))).toBe('subtle')
  for (const r of rows) expect(r.text).not.toMatch(/\S· /)
  await ui.press({ key: 'view-graph' })
  await ui.select({ key: 'inspect', value: `s:${FIRST(4)}` })
  const card = await ui.find({ type: 'Text', text: /Failed: tool error/ })
  expect(card?.text).toContain(ago(5 * 30_000))
  expect(card?.text).not.toContain('ago')
  await ui.unmount()
})

test('C6 adoption: a digit opens the queue item’s details in the graph view as in the list (the page’s openNth selects)', async ($, on) => {
  await seed($, on, { ui: { view: 'graph' } })
  const calls = recordLaunches(on, [])
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  const row = await ui.find({ key: 'att:local_0a1b2c3d-0000-4000-8000-000000000002' })
  expect(row?.props.hotkey).toBe('1')
  await ui.press({ key: 'att:local_0a1b2c3d-0000-4000-8000-000000000002' })
  expect(await ui.find({ key: 'detail-open' })).toBeDefined()
  expect(calls.some(argv => argv.some(a => a.startsWith('claude://')))).toBe(false)
  await ui.unmount()
})

const NAMED = /[A-Za-z]/
const PANE_ONLY_KEYS = ['l', 'g', 'p']
const KEYS = new Set([...KEY_MAP.map(k => k.key).filter(k => /^[a-z0-9]$/.test(k)), ...PANE_ONLY_KEYS])

/** Controls without a text name, and hotkeys outside today's set, in what the pane draws now. */
async function audit(ui: Awaited<ReturnType<TestEngine['ui']['mount']>>, view: string, found: string[]) {
  for (const b of await ui.findAll({ type: 'Button' })) {
    if (!NAMED.test(b.text)) found.push(`${view}: Button ${b.key} "${b.text}"`)
    const hotkey = b.props.hotkey
    if (typeof hotkey === 'string' && !KEYS.has(hotkey)) found.push(`${view}: new key ${hotkey} on ${b.key}`)
  }
  for (const type of ['Select', 'Input']) for (const el of await ui.findAll({ type })) if (!NAMED.test(String(el.props.label ?? ''))) found.push(`${view}: ${type} ${el.key} has no label`)
}

test('C10: every control in every pane view has a text name (0 glyph-only buttons) and no view adds a key', async ($, on) => {
  await seed($, on, {})
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  const found: string[] = []
  await audit(ui, 'list', found)
  await ui.press({ key: 'view-graph' })
  await audit(ui, 'graph', found)
  await ui.select({ key: 'inspect', value: `s:${KEY}` })
  await audit(ui, 'graph, session card', found)
  await ui.select({ key: 'inspect', value: 'p:c:\\repo\\app' })
  await audit(ui, 'graph, project card', found)
  await ui.press({ key: 'card-details' })
  await audit(ui, 'project detail', found)
  await ui.press({ key: 'view-list' })
  await ui.press({ key: `d:${KEY}` })
  await audit(ui, 'session detail', found)
  await ui.press({ key: 'sec-subagents' })
  await ui.press({ key: `ag:${KEY}/a1` })
  await audit(ui, 'agent detail', found)
  await ui.press({ key: 'view-settings' })
  await audit(ui, 'settings', found)
  await ui.press({ key: 's-clear' })
  await audit(ui, 'settings, confirm clear', found)
  await ui.press({ key: 's-clear-no' })
  await ui.press({ key: 's-diag' })
  await audit(ui, 'diagnostics', found)
  await ui.press({ key: 'view-new' })
  await audit(ui, 'new session', found)
  expect(found).toEqual([])
  await ui.unmount()
})

test('C10: the graph view with several projects names every control too, and draws the page map parts', async ($, on) => {
  await seed($, on, { snapshot: bucketed(50, 10), ui: { view: 'graph' } })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  const found: string[] = []
  await audit(ui, 'graph, 10 projects', found)
  expect(found).toEqual([])
  const source = String((await ui.find({ type: 'Svg' }))?.props.source ?? '')
  expect(source).toContain('class="n k-project"')
  expect(source).toContain('<polygon')
  expect(source).toContain('need')
  expect(await ui.find({ type: 'Text', text: /Needs you · 9/ })).toBeDefined()
  await ui.unmount()
})

test('C10: Diagnostics shows the arm switches, the notice and the error trace', async ($, on) => {
  await seed($, on, { ui: { view: 'diag' } })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Remote control/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Notice: / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Errors: none$/ })).toBeDefined()
  await ui.unmount()
})

test('a row warns when another active session works in the same checkout', async ($, on) => {
  await seed($, on, {})
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /same checkout as 1 other active session/ })).toBeDefined()
  await ui.unmount()
})

test('filters live in Settings; the list shows one note while they hide sessions, with Clear', async ($, on) => {
  await seed($, on, { filters: { time: '1h' } })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'search' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Filtered: Last hour/ })).toBeDefined()
  await ui.press({ key: 'filters-clear' })
  expect(await ui.find({ type: 'Text', text: /Filtered:/ })).toBeUndefined()
  await ui.press({ key: 'view-settings' })
  expect(await ui.find({ key: 'time' })).toBeDefined()
  expect(await ui.find({ key: 'search' })).toBeDefined()
  await ui.unmount()
})

test('E-39 (1 of 2): this test draws the pane three times', async ($, on) => {
  await seed($, on, {})
  for (const bodyColumns of [60, 61, 62]) {
    const ui = await mountPane($, { ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns } } as never)
    await ui.unmount()
  }
})

test('E-39 (2 of 2): the next test gets a fresh plugin instance, so the mod state (app, pub, inbox) starts clean', async ($, on) => {
  await seed($, on, { ui: { view: 'diag' } })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Pane renders: / }))?.text).toMatch(/^Pane renders: 1,/)
  expect((await ui.find({ type: 'Text', text: /^This session: / }))?.text).toContain('(0 writes)')
  await ui.unmount()
})

test('regression E-74: Transcript is offered on a sub-agent only when its parent session is the viewer itself, by id, never by the leader’s isOwnSession', () => {
  const parent = session(KEY)
  expect(isViewersAgent(parent, `cli-${KEY}`)).toBe(true)
  expect(isViewersAgent(parent, 'cli-someone-else')).toBe(false)
  expect(isViewersAgent({ ...parent, cliSessionId: null }, '')).toBe(false)
  expect(isViewersAgent(undefined, `cli-${KEY}`)).toBe(false)
})

test('C6 adoption: the pane keys follow KEY_MAP: c New session, n next need, 0 Fit, digits on the first nine queue items, Settings has none', async ($, on) => {
  await seed($, on, { snapshot: bucketed(12, 3) })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'view-new' }))?.props.hotkey).toBe('c')
  expect((await ui.find({ key: 'view-settings' }))?.props.hotkey).toBe(undefined)
  expect((await ui.find({ key: 'next-need' }))?.props.hotkey).toBe('n')
  const details = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('d:'))
  expect(details.slice(0, 9).map(b => b.props.hotkey)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
  expect(details.slice(9).every(b => b.props.hotkey === undefined)).toBe(true)
  expect(details.slice(0, 3).map(b => b.key)).toEqual([`d:${FIRST(6)}`, `d:${FIRST(0)}`, `d:${FIRST(4)}`])
  await ui.press({ key: 'view-graph' })
  expect((await ui.find({ key: 'fit' }))?.props.hotkey).toBe('0')
  expect((await ui.find({ type: 'Svg' }))?.props.width).toBe(432)
  await ui.unmount()
})

test('C6 adoption: n opens the session that has waited longest, then the next, then wraps', async ($, on) => {
  await seed($, on, { snapshot: bucketed(12, 3) })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  const opened: string[] = []
  for (let i = 0; i < 3; i += 1) {
    await ui.press({ key: 'next-need' })
    opened.push((await ui.find({ type: 'Text', text: /^Session \d+ working on feature \d+$/ }))?.text ?? '')
  }
  expect(opened).toEqual(['Session 6 working on feature 6', 'Session 0 working on feature 0', 'Session 6 working on feature 6'])
  await ui.unmount()
})

test('C6 adoption: Done from the details writes the shared mark, says so in the page words, and Undo (u) takes it back; Hide is not offered on a need', async ($, on) => {
  const { prefsNow } = await seed($, on, { snapshot: bucketed(12, 3), ui: { view: 'detail', selected: `s:${FIRST(0)}` } })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'detail-hide' })).toBeUndefined()
  expect((await ui.find({ key: 'detail-open' }))?.props.hotkey).toBe('o')
  expect((await ui.find({ key: 'detail-done' }))?.props.hotkey).toBe('d')
  expect((await ui.find({ key: 'detail-snooze' }))?.text).toBe('Snooze 1 hour')
  expect((await ui.find({ key: 'detail-snooze' }))?.props.hotkey).toBe('s')
  expect((await ui.find({ key: 'detail-snooze-tomorrow' }))?.text).toBe('Snooze until tomorrow')
  await ui.press({ key: 'detail-done' })
  expect(prefsNow().done?.[FIRST(0)]).toBe(NOW)
  expect(await ui.find({ type: 'Text', text: '“Session 0 working on feature 0” marked done.' })).toBeDefined()
  expect((await ui.find({ key: 'undo' }))?.props.hotkey).toBe('u')
  await ui.press({ key: 'undo' })
  expect(prefsNow().done?.[FIRST(0)]).toBe(undefined)
  expect(await ui.find({ key: 'undo' })).toBeUndefined()
  await ui.unmount()
})

test('C6 adoption: Snooze and Hide from the details and the graph card; a hidden session leaves the queue', async ($, on) => {
  const { prefsNow } = await seed($, on, { snapshot: bucketed(12, 3), ui: { view: 'detail', selected: `s:${FIRST(3)}` } })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  await ui.press({ key: 'detail-snooze' })
  expect(prefsNow().snoozed?.[FIRST(3)]).toEqual({ until: NOW + 3_600_000, at: NOW })
  await ui.press({ key: 'detail-snooze-tomorrow' })
  expect(prefsNow().snoozed?.[FIRST(3)]?.until).toBe(snoozeUntil('tomorrow', NOW))
  expect((await ui.find({ key: 'detail-hide' }))?.props.hotkey).toBe('h')
  await ui.press({ key: 'detail-hide' })
  expect(prefsNow().hidden?.[FIRST(3)]).toBe(NOW - 3 * 30_000)
  expect(await ui.find({ type: 'Text', text: '“Session 3 working on feature 3” hidden until it is active again.' })).toBeDefined()
  await ui.press({ key: 'view-list' })
  expect(await ui.find({ key: FIRST(3) })).toBeUndefined()
  await ui.press({ key: 'view-graph' })
  await ui.select({ key: 'inspect', value: `s:${FIRST(1)}` })
  expect((await ui.find({ key: 'card-done' }))?.props.hotkey).toBe('d')
  expect((await ui.find({ key: 'card-open' }))?.props.hotkey).toBe('o')
  expect((await ui.find({ key: 'card-hide' }))?.props.hotkey).toBe('h')
  await ui.unmount()
})

test('C6 adoption: the header counts needs in the one shared wording', async ($, on) => {
  await seed($, on, {})
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /1 needs you · 1 working/ })).toBeDefined()
  await ui.unmount()
})

test('C6 review A1/A2: a Done shows at once (the need count drops, the reason says Done), and Undo goes with its notice after 8 s', async ($, on) => {
  const { clock } = await seed($, on, { snapshot: bucketed(12, 3), ui: { view: 'detail', selected: `s:${FIRST(0)}` } })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^2 need you$/ })).toBeDefined()
  await ui.press({ key: 'detail-done' })
  expect(await ui.find({ type: 'Text', text: /^1 needs you$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Done$/ })).toBeDefined()
  expect(await ui.find({ key: 'undo' })).toBeDefined()
  await clock.advance(8_100)
  expect(await ui.find({ key: 'undo' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /marked done/ })).toBeUndefined()
  await ui.unmount()
})

test('C6 review A3/A5/A6: Next is a quiet button by the count, not a tab; Open says where; the agents toggle is not called Hide', async ($, on) => {
  await seed($, on, { ui: { view: 'graph' } })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'next-need' }))?.props.plain).toBe(true)
  await ui.select({ key: 'inspect', value: `s:${KEY}` })
  expect((await ui.find({ key: 'card-open' }))?.text).toBe('Open in Claude')
  expect((await ui.find({ key: 'card-collapse' }))?.text).toBe('Collapse agents')
  await ui.unmount()
})

test('C6 review A4: hidden sessions are counted on the surface, with Show to bring them back', async ($, on) => {
  const { prefsNow } = await seed($, on, { snapshot: bucketed(12, 3), ui: { view: 'detail', selected: `s:${FIRST(3)}` } })
  const ui = await mountPane($, { ...PANE, surface: 'desktop' })
  await ui.press({ key: 'detail-hide' })
  await ui.press({ key: 'view-list' })
  expect(await ui.find({ type: 'Text', text: /1 hidden/ })).toBeDefined()
  await ui.press({ key: 'hidden-show' })
  expect(prefsNow().hidden).toEqual({})
  expect(await ui.find({ key: FIRST(3) })).toBeDefined()
  await ui.unmount()
})
