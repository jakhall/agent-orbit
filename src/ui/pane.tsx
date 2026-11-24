import { atom, update } from 'claude-code'
import type { ElementTable, EngineInterface, RenderElement } from 'claude-code'

import type { AgentView, Diag, Filters, PaneUi, Prefs, ProjectView, SessionView, Settings, Snapshot } from '../../types'
import { APP_NAME, ATTENTION, DEFAULT_FILTERS, LIFECYCLE, TIME_PRESETS } from '../../shared/constants.js'
import { descendantsOf, toggled, visibleOf } from '../../shared/filters.js'
import { agentFields, ago, clockTime, isViewersAgent, limitsView, needsYouHotkey, peersNote, plural, projectFields, sessionFields, since, stateText, stuckText, truncate } from '../../shared/format.js'
import { inboxSummary } from '../../shared/inbox.js'
import { recentFolders } from '../../shared/links.js'
import { BUCKET_COLOR_KEY, bucketOf, listedSessions, needsYouText } from '../../shared/map.js'
import { ARMED_LEAD, armedCapabilities, donePatch, queueGroups, snoozePatch, snoozeUntil, statusOf } from '../../shared/popout.js'
import { applyMarks } from '../../shared/prefs.js'
import { isPrUrl } from '../../shared/prs.js'
import { lookupOf } from '../../shared/render.js'
import { app, clearData, popOut as appPopOut, tick, updatePrefs } from '../app'
import { isPublishing } from '../telemetry/publisher'
import { openDesktopSession, startNewSession } from '../nav/open-session'
import { errorText, resolvePaths } from '../paths'
import { INITIAL_UI, SHAPES } from '../state'
import { armLine, errorsLine, noticeLine } from './diag-lines'
import { withLocalMarks } from './marks'
import { paneMap } from './pane-map'

const uiAtom = atom({ plugin: 'orbit', key: 'ui' } as const, INITIAL_UI, { shape: SHAPES.ui })

type Queue = ReturnType<typeof queueGroups>

export type Table = ElementTable<'desktop'>

/** What the render hook hands the pane. */
export type PaneInput = {
  t: Table
  surface: string
  snapshot: Snapshot | null
  prefs: Prefs
  ui: PaneUi
  diag: Diag
  now: number
  bodyColumns: number
  placement: 'dock' | 'inline' | 'widget'
}

type PaneContext = PaneInput & {
  peers: Record<string, SessionView[]>
}

const bucketCount = (queue: Queue, key: Queue[number]['key']) => queue.find(g => g.key === key)?.rows.length ?? 0

/** The palette's status colours as the kit's theme keys (DESIGN.md "The pane"); the kit has no `dim`, its quiet grey is `subtle`. */
const KIT_COLOR = { amber: 'warning', coral: 'error', green: 'success', accent: 'suggestion', dim: 'subtle' } as const
/** A session's dot, by its D-4 bucket in the map's colour (`BUCKET_COLOR_KEY`). */
const dotOf = (s: SessionView) => KIT_COLOR[BUCKET_COLOR_KEY[bucketOf(s)] as keyof typeof KIT_COLOR]

const OPENING_HINT_MS = 2_000
const QUEUE_ROWS = 6
const PX_PER_COLUMN = 7.2

/** What is typed in the New session fields: kept out of state so a keystroke redraws nothing. */
const draft = { folder: '', prompt: '' }
let isStarting = false

async function setUi($: EngineInterface, change: (ui: PaneUi) => PaneUi): Promise<void> {
  await update($, uiAtom, change)
}

export async function setView($: EngineInterface, view: PaneUi['view']): Promise<void> {
  await setUi($, ui => ({ ...ui, previousView: ui.view === view ? ui.previousView : ui.view, view, confirmClear: false }))
}

async function back($: EngineInterface, ui: PaneUi, from: PaneUi['view']): Promise<void> {
  await setView($, ui.previousView === from ? 'list' : ui.previousView)
}

async function selectNode($: EngineInterface, id: string | null, view?: PaneUi['view']): Promise<void> {
  await setUi($, ui => ({
    ...ui,
    selected: id,
    previousView: view && view !== ui.view ? ui.view : ui.previousView,
    view: view ?? ui.view,
  }))
}

async function setFilters($: EngineInterface, change: (f: Filters) => Filters): Promise<void> {
  await updatePrefs($, prefs => ({ ...prefs, filters: change(prefs.filters) }))
}

async function setSettings($: EngineInterface, change: (s: Settings) => Settings): Promise<void> {
  await updatePrefs($, prefs => ({ ...prefs, settings: change(prefs.settings) }))
  void tick($, true)
}

const openedAt = new Map<string, number>()

async function openSession($: EngineInterface, session: SessionView): Promise<void> {
  if (!session.localId) {
    await selectNode($, `s:${session.key}`, 'detail')
    return
  }
  const now = await $.clock.now()
  if (now - (openedAt.get(session.localId) ?? 0) < OPENING_HINT_MS) return
  openedAt.set(session.localId, now)
  const paths = app.paths ?? (await resolvePaths($))
  const localId = session.localId
  const launched = openDesktopSession($, paths, localId).catch(error => {
    openedAt.delete(localId)
    $.ui.toast(`Could not open session: ${errorText(error)}`)
  })
  await setUi($, ui => ({ ...ui, openingKey: session.key }))
  $.clock.after(OPENING_HINT_MS, () => void setUi($, ui => (ui.openingKey === session.key ? { ...ui, openingKey: null } : ui)))
  await launched
}

async function togglePinned($: EngineInterface, key: string): Promise<void> {
  await updatePrefs($, prefs => ({ ...prefs, pinned: toggled(prefs.pinned, key) }))
}

async function toggleCollapsed($: EngineInterface, id: string): Promise<void> {
  await updatePrefs($, prefs => ({ ...prefs, collapsed: toggled(prefs.collapsed, id) }))
}

/** Selects a node and, when the pane graph is zoomed in, centres it. */
async function selectAndCentre($: EngineInterface, id: string | null): Promise<void> {
  const fit = app.lastFit
  const node = id ? app.lastNodes.find(n => n.id === id) : undefined
  await setUi($, ui => ({
    ...ui,
    selected: id,
    camera:
      node && fit && ui.camera.zoom > 1
        ? { ...ui.camera, panX: (node.x - (fit.x + fit.w / 2)) / fit.w, panY: (node.y - (fit.y + fit.h / 2)) / fit.h }
        : ui.camera,
  }))
}

async function popOut($: EngineInterface): Promise<void> {
  await setUi($, ui => ({ ...ui, notice: 'Opening the pop-out window…' }))
  const result = await appPopOut($)
  await setUi($, ui => ({ ...ui, notice: result.ok ? result.message : `Pop-out failed: ${result.message}` }))
}

/**
 * One line of counts and one row of short buttons; the active view is the
 * only one drawn at full strength. Filters live in the Settings view.
 */
function Header($: EngineInterface, c: PaneContext, queue: Queue): RenderElement {
  const { t, ui, surface, snapshot, now } = c
  const high = limitsView(snapshot?.usage, now)?.parts.filter(p => p.isHigh) ?? []
  const { Box, Text, Button } = t
  const view = ui.view
  const needs = bucketCount(queue, 'needs-you')
  const armed = c.diag.armed ?? []
  const chips = armedCapabilities({ approvals: armed.includes('approvals'), questions: armed.includes('questions'), replies: armed.includes('replies') })
  const tab = (key: string, label: string, hotkey: string | undefined, target: PaneUi['view'], press: () => void) => (
    <Button key={key} label={label} hotkey={hotkey} dimColor={view !== target} onPress={press} />
  )
  return (
    <Box flexDirection="column" gap="xs">
      <Box flexDirection="row" gap="xs" alignItems="center" flexWrap="wrap">
        <Text>
          <Text weight="semibold">{APP_NAME}</Text>
          <Text size="footnote">
            {'  '}
            <Text weight={needs > 0 ? 'semibold' : undefined} dimColor={needs === 0}>
              {needsYouText(needs)}
            </Text>
            <Text dimColor>
              {' · '}
              {bucketCount(queue, 'working')} working
              {high.length > 0 ? ` · limit ${high.map(p => p.text).join(', ')}` : ''}
            </Text>
          </Text>
        </Text>
        {needs > 0 && <Button key="next-need" label="Next that needs you" hotkey="n" plain dimColor onPress={() => void openNextNeed($, queue, ui.selected)} />}
      </Box>
      {chips.length > 0 && (
        <Text size="footnote">
          {ARMED_LEAD} {chips.map(chip => chip.label).join(', ')}
        </Text>
      )}
      <Box flexDirection="row" gap="xs" flexWrap="wrap">
        {tab('view-list', 'List', 'l', 'list', () => void setView($, 'list'))}
        {tab('view-graph', 'Graph', 'g', 'graph', () => void setView($, 'graph'))}
        {surface !== 'mobile' && tab('view-new', 'New', 'c', 'new', () => void openNew($, null))}
        <Button key="pop-out" label="Pop out" hotkey="p" dimColor onPress={() => void popOut($)} />
        {tab('view-settings', 'Settings', undefined, 'settings', () => void setView($, view === 'settings' ? ui.previousView : 'settings'))}
      </Box>
    </Box>
  )
}

/** A one-line reminder that filters hide sessions, with a way out. Null at the defaults. */
function FilterNote($: EngineInterface, c: PaneContext, hiddenCount: number): RenderElement | null {
  const { t, prefs } = c
  const { Box, Text, Button } = t
  const f = prefs.filters
  const parts = [
    f.time !== DEFAULT_FILTERS.time ? (TIME_PRESETS.find(p => p.value === f.time)?.label ?? f.time) : '',
    f.search ? `“${truncate(f.search, 20)}”` : '',
    f.project ? 'one project' : '',
    f.model ? 'one model' : '',
    f.lifecycle ? (LIFECYCLE[f.lifecycle as keyof typeof LIFECYCLE]?.label ?? '') : '',
    f.attentionOnly ? 'needs you only' : '',
    !f.showCompleted ? 'no completed' : '',
    !f.showStale ? 'no stale' : '',
  ].filter(Boolean)
  if (parts.length === 0 && hiddenCount === 0) return null
  return (
    <Box flexDirection="row" gap="xs" alignItems="center" flexWrap="wrap">
      {parts.length > 0 && (
        <Text size="footnote" dimColor>
          Filtered: {parts.join(', ')}
        </Text>
      )}
      {parts.length > 0 && <Button key="filters-clear" label="Clear" plain dimColor onPress={() => void setFilters($, () => ({ ...DEFAULT_FILTERS }))} />}
      {hiddenCount > 0 && (
        <Text size="footnote" dimColor>
          {hiddenCount} hidden until active
        </Text>
      )}
      {hiddenCount > 0 && <Button key="hidden-show" label="Show hidden" plain dimColor onPress={() => void updatePrefs($, p => ({ ...p, hidden: {} }))} />}
    </Box>
  )
}

/** Shows the New session view, with `folder` (or the last one typed, or the most recent project) filled in. */
export async function openNew($: EngineInterface, folder: string | null): Promise<void> {
  if (folder) draft.folder = folder
  else if (draft.folder === '' && app.snapshot) draft.folder = recentFolders(app.snapshot, 1)[0]?.path ?? ''
  await setUi($, ui => ({ ...ui, create: { status: 'editing', message: null, revision: ui.create.revision + 1 } }))
  await setView($, 'new')
}

async function createSession($: EngineInterface): Promise<void> {
  if (isStarting) return
  isStarting = true
  try {
    await setUi($, ui => ({ ...ui, create: { ...ui.create, status: 'starting', message: null } }))
    const paths = app.paths ?? (await resolvePaths($))
    const result = await startNewSession($, paths, draft.folder, draft.prompt).catch(error => ({ ok: false, message: errorText(error) }))
    if (result.ok) draft.prompt = ''
    await setUi($, ui => ({ ...ui, create: { status: result.ok ? 'started' : 'failed', message: result.message, revision: ui.create.revision + 1 } }))
  } finally {
    isStarting = false
  }
}

function NewSessionView($: EngineInterface, c: PaneContext): RenderElement {
  const { t, snapshot, ui } = c
  const { Box, Text, Button } = t
  const folders = snapshot ? recentFolders(snapshot, 12) : []
  const picked = folders.find(f => f.path.toLowerCase() === draft.folder.toLowerCase())
  const create = ui.create
  return (
    <Box flexDirection="column" gap={1}>
      {BackRow($, c, 'new', 'New session')}
      {folders.length > 0 && (
        <t.Select
          key="new-pick"
          label="Recent"
          options={[...folders.map(f => ({ value: f.path, label: `${truncate(f.label, 36)} · ${truncate(f.path, 48)}` })), { value: '', label: 'Another folder (type it below)' }]}
          value={picked?.path ?? ''}
          onSelect={value => {
            draft.folder = value
            void setUi($, u => ({ ...u, create: { ...u.create, revision: u.create.revision + 1 } }))
          }}
        />
      )}
      <t.Input
        key={`new-folder-${create.revision}`}
        label="Folder"
        placeholder="C:\repos\app"
        value={draft.folder}
        submitLabel="open"
        onInput={value => {
          draft.folder = value
        }}
        onSubmit={value => {
          draft.folder = value
          void createSession($)
        }}
      />
      <t.Input
        key={`new-prompt-${create.revision}`}
        label="First prompt (optional)"
        rows={3}
        value={draft.prompt}
        submitLabel="open"
        onInput={value => {
          draft.prompt = value
        }}
        onSubmit={value => {
          draft.prompt = value
          void createSession($)
        }}
      />
      <Box flexDirection="row" gap="xs" alignItems="center">
        <Button key="new-start" label={create.status === 'starting' ? 'Opening…' : 'Start'} variant="primary" onPress={() => void createSession($)} />
      </Box>
      <Text size="footnote" dimColor={create.status !== 'failed'}>
        {create.message ?? 'Nothing is sent until you press Enter in Claude.'}
      </Text>
    </Box>
  )
}

/** The filter fields, shown in the Settings view; the list and graph show only a FilterNote. */
function FilterFields($: EngineInterface, c: PaneContext, options: { projectOptions: { value: string; label: string }[]; modelOptions: { value: string; label: string }[] }): RenderElement {
  const { t, prefs } = c
  const { Box, Button } = t
  const f = prefs.filters
  const any = (label: string) => ({ value: '', label })
  return (
    <Box flexDirection="column" gap="xs">
      <t.Select
        key="time"
        label="Time"
        options={TIME_PRESETS.map(p => ({ value: p.value, label: p.label }))}
        value={f.time}
        onSelect={value => void setFilters($, filters => ({ ...filters, time: value as Filters['time'] }))}
      />
      <t.Input key="search" label="Search" value={f.search} submitLabel="search" onSubmit={value => void setFilters($, filters => ({ ...filters, search: value.trim() }))} />
      <t.Select key="f-project" label="Project" options={[any('All projects'), ...options.projectOptions]} value={f.project} onSelect={value => void setFilters($, filters => ({ ...filters, project: value }))} />
      <t.Select key="f-model" label="Model" options={[any('All models'), ...options.modelOptions]} value={f.model} onSelect={value => void setFilters($, filters => ({ ...filters, model: value }))} />
      <t.Select
        key="f-lifecycle"
        label="State"
        options={[any('Any state'), ...Object.entries(LIFECYCLE).map(([value, v]) => ({ value, label: v.label }))]}
        value={f.lifecycle}
        onSelect={value => void setFilters($, filters => ({ ...filters, lifecycle: value }))}
      />
      <Box flexDirection="row" gap="xs" flexWrap="wrap">
        <Button key="f-completed" label={`Completed: ${f.showCompleted ? 'shown' : 'hidden'}`} dimColor={!f.showCompleted} onPress={() => void setFilters($, x => ({ ...x, showCompleted: !x.showCompleted }))} />
        <Button key="f-stale" label={`Stale: ${f.showStale ? 'shown' : 'hidden'}`} dimColor={!f.showStale} onPress={() => void setFilters($, x => ({ ...x, showStale: !x.showStale }))} />
        <Button key="f-attention" label={`Needs you only: ${f.attentionOnly ? 'on' : 'off'}`} dimColor={!f.attentionOnly} onPress={() => void setFilters($, x => ({ ...x, attentionOnly: !x.attentionOnly }))} />
        <Button key="f-reset" label="Reset filters" dimColor onPress={() => void setFilters($, () => ({ ...DEFAULT_FILTERS }))} />
      </Box>
    </Box>
  )
}

/** Characters a pane line holds before it wraps. */
function lineChars(c: PaneContext, reserve: number): number {
  return Math.max(20, Math.min(110, c.bodyColumns - reserve))
}

/** The age a queue row shows, as the page rail: since its status began, else since its last activity. */
function rowAge(s: SessionView, now: number): string {
  const at = statusOf(s).since
  return typeof at === 'number' ? ago(now - at) : ''
}

/** The graph view's short queue: the Needs you group of the page's queue, longest waiting first. */
function NeedsYouQueue($: EngineInterface, c: PaneContext, queue: Queue): RenderElement | null {
  const items = queue.find(g => g.key === 'needs-you')?.rows ?? []
  if (items.length === 0) return null
  const { t, now } = c
  const { Box, Text, Button } = t
  const rows = c.placement === 'dock' ? 3 : QUEUE_ROWS
  const more = items.length - rows
  return (
    <Box flexDirection="column" gap="xs">
      <Text size="caption" weight="semibold">
        Needs you · {items.length}
      </Text>
      {items.slice(0, rows).map((s, i) => (
        <Button key={`att:${s.key}`} plain hotkey={needsYouHotkey(i) ?? undefined} onPress={() => void selectNode($, `s:${s.key}`, 'detail')}>
          <Text>{truncate(s.title, lineChars(c, 22))} </Text>
          <Text size="footnote" color={dotOf(s)}>
            ●{' '}
          </Text>
          <Text size="footnote" dimColor>
            {statusReason(s, now)} · {rowAge(s, now)}
          </Text>
        </Button>
      ))}
      {more > 0 && <Button key="att-more" label={`${more} more in the list`} plain dimColor onPress={() => void setView($, 'list')} />}
    </Box>
  )
}

/**
 * A queue row as on the page rail: the title, then its dot, reason and age,
 * and the few facts that tell sessions apart. Pressing it opens the session;
 * Details opens its details.
 */
function QueueRow($: EngineInterface, c: PaneContext, s: SessionView, projects: Map<string, ProjectView>, hotkey: string | undefined): RenderElement {
  const { t, ui, now, prefs } = c
  const { Box, Text, Button } = t
  const isMe = s.cliSessionId !== null && s.cliSessionId === app.me
  const reason = ui.openingKey === s.key ? 'Opening…' : statusReason(s, now)
  const age = rowAge(s, now)
  const facts = [
    projects.get(s.projectId)?.name ?? '',
    isMe ? 'this session' : '',
    s.environment !== 'desktop' ? `${s.environment}, view-only` : '',
    prefs.pinned.includes(s.key) ? 'Pinned' : '',
  ].filter(Boolean)
  const head = age ? `${reason} · ${age}` : reason
  const peerCount = c.peers[s.key]?.length ?? 0
  return (
    <Box key={`row-${s.key}`} flexDirection="row" gap="xs" alignItems="flex-start" hover={{ backgroundColor: 'promptBorder' }}>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <Button key={s.key} plain onPress={() => void openSession($, s)}>
          <Text weight="semibold">{truncate(s.title, lineChars(c, 12))}</Text>
          <Text size="footnote">{'\n'}</Text>
          <Text size="footnote" color={dotOf(s)}>
            ●{' '}
          </Text>
          <Text size="footnote">{head}</Text>
          <Text size="footnote" dimColor>
            {facts.length > 0 ? ` · ${truncate(facts.join(' · '), Math.max(10, lineChars(c, 12) - head.length - 3))}` : ''}
            {peerCount > 0 ? `\n${peersNote(peerCount)}` : ''}
          </Text>
        </Button>
      </Box>
      <Button key={`d:${s.key}`} label="Details" plain dimColor hotkey={hotkey} onPress={() => void selectNode($, `s:${s.key}`, 'detail')} />
    </Box>
  )
}

/** The page's queue (D-4 buckets, Needs you first), one section per bucket; digits reach the first nine items' details, as on the page. */
function QueueView($: EngineInterface, c: PaneContext, queue: Queue, projects: Map<string, ProjectView>, withHotkeys: boolean): RenderElement {
  const { t } = c
  const { Box, Text } = t
  const firstIndex = new Map<string, number>()
  let index = 0
  for (const group of queue) for (const s of group.rows) firstIndex.set(s.key, index++)
  return (
    <Box flexDirection="column" gap={1}>
      {queue.map(group => (
        <Box key={`sec-${group.key}`} flexDirection="column" gap="xs">
          <Text size="caption" weight="semibold">
            {group.label} · {group.rows.length}
          </Text>
          {group.rows.map(s => QueueRow($, c, s, projects, withHotkeys ? (needsYouHotkey(firstIndex.get(s.key) ?? 99) ?? undefined) : undefined))}
        </Box>
      ))}
    </Box>
  )
}

function GraphView($: EngineInterface, c: PaneContext, visible: ReturnType<typeof visibleOf>, snapshot: Snapshot): RenderElement {
  const { t, ui, prefs, now, surface } = c
  const { Box, Text, Button } = t
  if (surface !== 'desktop' && surface !== 'vscode') {
    return (
      <Text dimColor>The graph needs the desktop app. Use List, or Pop out.</Text>
    )
  }
  const aspect = c.placement === 'dock' ? 0.85 : 2
  const paneWidth = Math.max(240, c.bodyColumns * PX_PER_COLUMN)
  const nodes = visible.nodes
  const focusIds = ui.focus ? descendantsOf(ui.focus, nodes) : null
  const map = paneMap(nodes, visible.edges, lookupOf(snapshot), {
    stagePx: { w: paneWidth, h: paneWidth / aspect },
    camera: ui.camera,
    selected: ui.selected,
    now,
    pinned: new Set(prefs.pinned),
    overflow: visible.overflow,
    framed: focusIds ? nodes.filter(n => focusIds.has(n.id)) : undefined,
    stack: c.placement === 'dock',
  })
  const svg = map.svg
  app.lastNodes = map.nodes
  app.lastFit = map.fit
  app.lastSvgChars = svg.length
  const tooBig = svg.length > 131_000
  const camera = (change: (cam: PaneUi['camera']) => PaneUi['camera']) => void setUi($, u => ({ ...u, camera: change(u.camera) }))
  const projects = nodes.filter(n => n.kind === 'project')
  return (
    <Box flexDirection="column" gap="xs">
      <Box flexDirection="row" gap="xs" flexWrap="wrap" alignItems="center">
        <Button key="zoom-out" label="Zoom out" onPress={() => camera(cam => ({ ...cam, zoom: Math.max(0.25, cam.zoom / 1.4) }))} />
        <Button key="zoom-in" label="Zoom in" onPress={() => camera(cam => ({ ...cam, zoom: Math.min(8, cam.zoom * 1.4) }))} />
        <Button key="fit" label="Fit" hotkey="0" onPress={() => void setUi($, u => ({ ...u, focus: null, camera: { zoom: 1, panX: 0, panY: 0 } }))} />
        {projects.length > 1 && (
          <t.Select
            key="focus"
            label="Project"
            options={[{ value: '', label: 'All projects' }, ...projects.map(p => ({ value: p.id, label: p.label }))]}
            value={ui.focus ?? ''}
            onSelect={value => void setUi($, u => ({ ...u, focus: value === '' ? null : value, camera: { zoom: 1, panX: 0, panY: 0 } }))}
          />
        )}
      </Box>
      {tooBig ? (
        <Text>Too many nodes to draw here ({nodes.length}). Filter, simplify, or Pop out.</Text>
      ) : (
        <t.Svg source={svg} width={Math.round(paneWidth)} alt={`Constellation: ${visible.counts.sessions} sessions in ${projects.length} projects`} isInteractive />
      )}
      <t.Select
        key="inspect"
        label="Inspect"
        options={[
          { value: '', label: 'Choose a node…' },
          ...nodes
            .filter(n => n.kind === 'session' || n.kind === 'project' || n.kind === 'agent')
            .slice(0, 150)
            .map(n => ({ value: n.id, label: `${truncate(n.label, 50)}${n.kind === 'project' ? ' (project)' : n.kind === 'agent' ? ' (subagent)' : ''}` })),
        ]}
        value={ui.selected ?? ''}
        onSelect={value => void selectAndCentre($, value === '' ? null : value)}
      />
      {ui.selected && SelectedCard($, c, snapshot)}
    </Box>
  )
}

function SelectedCard($: EngineInterface, c: PaneContext, snapshot: Snapshot): RenderElement | null {
  const { t, ui, prefs, now } = c
  const { Box, Text, Button } = t
  const id = ui.selected
  if (!id) return null
  const isCollapsed = prefs.collapsed.includes(id)
  if (id.startsWith('s:')) {
    const s = snapshot.sessions.find(x => `s:${x.key}` === id)
    if (!s) return null
    return (
      <Box flexDirection="column" gap="xs" paddingX={1}>
        <Text weight="semibold">{truncate(s.title, 70)}</Text>
        <Text size="footnote">
          <Text color={dotOf(s)}>● </Text>
          {statusReason(s, now)}
          <Text dimColor>{rowAge(s, now) ? ` · ${rowAge(s, now)}` : ''}</Text>
        </Text>
        {(c.peers[s.key]?.length ?? 0) > 0 && (
          <Text size="footnote" dimColor>
            {peersNote(c.peers[s.key]?.length ?? 0)}
          </Text>
        )}
        <Box flexDirection="row" gap="xs" flexWrap="wrap">
          {s.canOpen && <Button key="card-open" label="Open in Claude" hotkey="o" variant="primary" onPress={() => void openSession($, s)} />}
          <Button key="card-details" label="Details" onPress={() => void setView($, 'detail')} />
          <Button key="card-pin" label={prefs.pinned.includes(s.key) ? 'Unpin' : 'Pin'} dimColor onPress={() => void togglePinned($, s.key)} />
        </Box>
        {TriageButtons($, c, s, 'card')}
        <Box>
          {s.agentKeys.length > 0 && <Button key="card-collapse" label={isCollapsed ? 'Show agents' : 'Collapse agents'} dimColor onPress={() => void toggleCollapsed($, id)} />}
        </Box>
      </Box>
    )
  }
  if (id.startsWith('p:')) {
    const p = snapshot.projects.find(x => `p:${x.id}` === id)
    if (!p) return null
    return (
      <Box flexDirection="column" gap="xs" paddingX={1}>
        <Text weight="semibold">{p.name}</Text>
        <Text size="footnote" dimColor>
          {p.root}
          {p.remote ? ` · ${p.remote}` : ''} · {plural(p.sessionKeys.length, 'session')}
        </Text>
        <Box flexDirection="row" gap="xs" flexWrap="wrap">
          <Button key="card-focus" label="Focus" onPress={() => void setUi($, u => ({ ...u, focus: id, camera: { zoom: 1, panX: 0, panY: 0 } }))} />
          <Button key="card-new" label="+ New" dimColor onPress={() => void openNew($, p.root)} />
          <Button key="card-details" label="Details" onPress={() => void setView($, 'detail')} />
          <Button key="card-collapse" label={isCollapsed ? 'Expand' : 'Collapse'} dimColor onPress={() => void toggleCollapsed($, id)} />
        </Box>
      </Box>
    )
  }
  if (id.startsWith('a:')) {
    const a = snapshot.agents.find(x => `a:${x.key}` === id)
    if (!a) return null
    return (
      <Box flexDirection="column" gap="xs" paddingX={1}>
        <Text weight="semibold">
          {a.type}: {truncate(a.description, 60)}
        </Text>
        <Text size="footnote">
          <Text color={LIFECYCLE[a.lifecycle].dot}>● </Text>
          {LIFECYCLE[a.lifecycle].label}
        </Text>
        <Box flexDirection="row" gap="xs">
          <Button key="card-details" label="Details" onPress={() => void setView($, 'detail')} />
          <Button key="card-parent" label="Parent" dimColor onPress={() => void selectNode($, `s:${a.sessionKey}`)} />
        </Box>
      </Box>
    )
  }
  return null
}

type Field = [label: string, value: string, isMono: boolean, isMore?: boolean]

/** Detail rows; the `isMore` ones show only after "More details". */
function Fields($: EngineInterface, c: PaneContext, rows: Field[], prefix: string, extra?: RenderElement): RenderElement {
  const { t, ui } = c
  const { Box, Text, Button } = t
  const isOpen = ui.moreOpen === true
  const more = rows.filter(r => r[3])
  const shown = isOpen ? rows : rows.filter(r => !r[3])
  return (
    <Box flexDirection="column">
      {shown.map(([label, value, isMono], i) => (
        <Text key={`${prefix}-${i}`} size="footnote" mono={isMono || undefined}>
          <Text dimColor>{label}: </Text>
          {value}
        </Text>
      ))}
      {(more.length > 0 || extra) && (
        <Box flexDirection="row" gap="xs">
          {more.length > 0 && <Button key={`${prefix}-more`} label={isOpen ? 'Fewer details' : 'More details'} plain dimColor onPress={() => void setUi($, u => ({ ...u, moreOpen: !u.moreOpen }))} />}
          {isOpen && extra}
        </Box>
      )}
    </Box>
  )
}

/** A section that stays closed until asked for: an accent heading with its count, the body once open. */
function Disclosure($: EngineInterface, c: PaneContext, key: string, title: string, count: number, body: () => RenderElement): RenderElement {
  const { t, ui } = c
  const { Box, Text, Button } = t
  const isOpen = ui.openSections?.includes(key) ?? false
  return (
    <Box flexDirection="column" gap="xs">
      <Button key={`sec-${key}`} plain onPress={() => void setUi($, u => ({ ...u, openSections: toggled(u.openSections ?? [], key) }))}>
        <Text color="suggestion">{isOpen ? '▾ ' : '▸ '}</Text>
        <Text size="caption" weight="semibold">
          {title}
        </Text>
        <Text size="caption" dimColor>
          {' '}
          {count}
        </Text>
      </Button>
      {isOpen && body()}
    </Box>
  )
}

function BackRow($: EngineInterface, c: PaneContext, from: PaneUi['view'], title: string | null): RenderElement {
  const { t, ui } = c
  const { Box, Text, Button } = t
  return (
    <Box flexDirection="row" gap="xs" alignItems="center">
      <Button key={`${from}-back`} label="‹ Back" plain dimColor onPress={() => void back($, ui, from)} />
      {title && (
        <Text size="caption" weight="semibold">
          {title}
        </Text>
      )}
    </Box>
  )
}

function SessionDetail($: EngineInterface, c: PaneContext, s: SessionView, snapshot: Snapshot): RenderElement {
  const { t, now, prefs, ui } = c
  const isPinned = prefs.pinned.includes(s.key)
  const { Box, Text, Button, Link } = t
  const staleMs = prefs.settings.staleMinutes * 60_000
  const project = snapshot.projects.find(p => p.id === s.projectId)
  const worktree = s.worktreeId ? snapshot.worktrees.find(w => w.id === s.worktreeId) : undefined
  const agents = snapshot.agents.filter(a => a.sessionKey === s.key)
  return (
    <Box flexDirection="column" gap={1}>
      {BackRow($, c, 'detail', null)}
      <Box flexDirection="column" gap="xs">
        <Text size="heading" weight="semibold">
          {s.title}
        </Text>
        <Text size="footnote">
          <Text color={dotOf(s)}>● </Text>
          <Text>{statusReason(s, now)}</Text>
          <Text dimColor>
            {s.attention === 'review' ? ` · ${ATTENTION.review.label}` : ''}
            {isPinned ? ' · Pinned' : ''}
          </Text>
        </Text>
        {s.stuck && (
          <Text key="detail-stuck" size="footnote" dimColor>
            {stuckText(s)}
          </Text>
        )}
        <Box flexDirection="row" gap="xs" flexWrap="wrap">
          {s.canOpen ? (
            <Button key="detail-open" label={ui.openingKey === s.key ? 'Opening…' : 'Open in Claude'} hotkey="o" variant="primary" onPress={() => void openSession($, s)} />
          ) : (
            s.environment !== 'desktop' && (
              <Text size="footnote" dimColor>
                {s.environment} session: switch to it there.
              </Text>
            )
          )}
          <Button key="detail-pin" label={isPinned ? 'Unpin' : 'Pin'} onPress={() => void togglePinned($, s.key)} />
        </Box>
        {TriageButtons($, c, s, 'detail')}
        <Box>
          {s.cwd && <Button key="detail-new" label="+ New" onPress={() => void openNew($, s.cwd)} />}
        </Box>
      </Box>
      {Fields(
        $,
        c,
        sessionFields(s, project, worktree, now, staleMs, c.peers[s.key]),
        'f',
        <Button
          key="detail-copy"
          label="Copy ID"
          plain
          dimColor
          onPress={press => void $.ui.copy({ text: s.localId ?? s.cliSessionId ?? s.key, surface: press.surface }).then(() => $.ui.toast('Session ID copied'))}
        />,
      )}
      {s.publisher === null && (
        <Text size="footnote" dimColor>
          No live data: restart this session to load Orbit.
        </Text>
      )}
      {agents.length > 0 &&
        Disclosure($, c, 'subagents', 'Subagents', agents.length, () => (
          <Box flexDirection="column" gap="xs">
            {agents.slice(0, 20).map(a => (
              <Button key={`ag:${a.key}`} plain onPress={() => void selectNode($, `a:${a.key}`, 'detail')}>
                <Text color={LIFECYCLE[a.lifecycle].dot}>● </Text>
                <Text>{truncate(a.description || a.type, lineChars(c, 10))}</Text>
              </Button>
            ))}
          </Box>
        ))}
      {s.timeline.length > 0 &&
        Disclosure($, c, 'activity', 'Activity', s.timeline.length, () => (
          <Box flexDirection="column">
            {s.timeline.slice(0, 10).map((entry, i) => (
              <Text key={`tl-${i}`} size="footnote" dimColor>
                {clockTime(entry.at).slice(11)} {truncate(entry.text, 90)}
              </Text>
            ))}
          </Box>
        ))}
      {s.prs.length > 0 &&
        Disclosure($, c, 'prs', 'Pull requests', s.prs.length, () => (
          <Box flexDirection="column" gap="xs">
            {s.prs.map(pr => (
              <Text key={`pr-${pr.url}`} size="footnote">
                {isPrUrl(pr.url) ? <Link href={pr.url} label={`${pr.repo} #${pr.number}`} /> : `${pr.repo} #${pr.number}`} {pr.state.toLowerCase()}
              </Text>
            ))}
          </Box>
        ))}
    </Box>
  )
}

function AgentDetail($: EngineInterface, c: PaneContext, a: AgentView, snapshot: Snapshot): RenderElement {
  const { t, now, prefs, ui } = c
  const { Box, Text, Button } = t
  const parent = snapshot.sessions.find(s => s.key === a.sessionKey)
  const isMine = isViewersAgent(parent, app.me)
  const life = LIFECYCLE[a.lifecycle]
  return (
    <Box flexDirection="column" gap={1}>
      {BackRow($, c, 'detail', null)}
      <Box flexDirection="column" gap="xs">
        <Text size="heading" weight="semibold">
          {truncate(a.description || a.type, 80)}
        </Text>
        <Text size="footnote">
          <Text color={life.dot}>● </Text>
          <Text>{life.label}</Text>
        </Text>
        <Box flexDirection="row" gap="xs" flexWrap="wrap">
          <Button key="agent-parent" label="Parent session" variant="primary" onPress={() => void selectNode($, `s:${a.sessionKey}`, 'detail')} />
          {isMine && (
            <Button
              key="agent-view"
              label="Transcript"
              onPress={() =>
                void $.ui.view({ agentId: a.id }).then(r => {
                  if ('deny' in r && r.deny) $.ui.toast(`Cannot show it: ${r.deny}`)
                })
              }
            />
          )}
        </Box>
      </Box>
      {Fields($, c, agentFields(a, parent?.title ?? a.sessionKey, now, prefs.settings.staleMinutes * 60_000), 'a')}
      {a.recent.length > 0 &&
        Disclosure($, c, 'recent', 'Recent actions', a.recent.length, () => (
          <Box flexDirection="column">
            {a.recent.map((entry, i) => (
              <Text key={`ar-${i}`} size="footnote" dimColor>
                {clockTime(entry.at).slice(11)} {truncate(entry.text, 90)}
              </Text>
            ))}
          </Box>
        ))}
    </Box>
  )
}

function ProjectDetail($: EngineInterface, c: PaneContext, p: ProjectView, snapshot: Snapshot, projects: Map<string, ProjectView>): RenderElement {
  const { t, ui } = c
  const { Box, Text, Button } = t
  const sessions = snapshot.sessions.filter(s => s.projectId === p.id)
  const worktrees = snapshot.worktrees.filter(w => w.projectId === p.id)
  return (
    <Box flexDirection="column" gap={1}>
      {BackRow($, c, 'detail', null)}
      <Text size="heading" weight="semibold">
        {p.name}
      </Text>
      <Box flexDirection="row" gap="xs">
        <Button key="p-new" label="+ New session" variant="primary" onPress={() => void openNew($, p.root)} />
      </Box>
      {Fields($, c, projectFields(p), 'p')}
      {worktrees.length > 1 &&
        Disclosure($, c, 'checkouts', 'Checkouts', worktrees.length, () => (
          <Box flexDirection="column">
            {worktrees.map(w => (
              <Text key={`wt-${w.id}`} size="footnote" dimColor>
                {w.branch ?? (w.isMain ? 'main checkout' : 'worktree')} · {w.path} · {plural(w.sessionKeys.length, 'session')}
              </Text>
            ))}
          </Box>
        ))}
      {QueueView($, c, queueGroups(sessions, c.now), projects, false)}
    </Box>
  )
}

function SettingsView($: EngineInterface, c: PaneContext, visible: ReturnType<typeof visibleOf> | null): RenderElement {
  const { t, prefs, ui } = c
  const { Box, Text, Button } = t
  const s = prefs.settings
  const sel = (key: string, label: string, value: string, options: [string, string][], apply: (v: string) => (s: Settings) => Settings) => (
    <t.Select key={key} label={label} value={value} options={options.map(([v, l]) => ({ value: v, label: l }))} onSelect={v => void setSettings($, apply(v))} />
  )
  const toggle = (key: string, label: string, on: boolean, apply: (s: Settings) => Settings) => (
    <Button key={key} label={`${label}: ${on ? 'on' : 'off'}`} dimColor={!on} onPress={() => void setSettings($, apply)} />
  )
  return (
    <Box flexDirection="column" gap={1}>
      {BackRow($, c, 'settings', 'Filters')}
      {c.surface !== 'mobile' && FilterFields($, c, visible ?? { projectOptions: [], modelOptions: [] })}
      <Text size="caption" weight="semibold">
        Settings
      </Text>
      <Box flexDirection="column" gap="xs">
        {sel('s-anim', 'Pop-out animation', s.animation, [['off', 'Off'], ['low', 'Low'], ['normal', 'Normal']], v => x => ({ ...x, animation: v as Settings['animation'] }))}
        {sel('s-refresh', 'Refresh every', String(s.refreshSec), [['5', '5 s'], ['10', '10 s'], ['20', '20 s'], ['30', '30 s'], ['60', '60 s']], v => x => ({ ...x, refreshSec: Number(v) }))}
        {sel('s-max', 'Sessions kept', String(s.maxSessions), [['25', '25'], ['50', '50'], ['100', '100'], ['200', '200']], v => x => ({ ...x, maxSessions: Number(v) }))}
        {sel('s-agents', 'Subagents shown per session', String(s.maxSubagents), [['0', 'None'], ['4', '4'], ['8', '8'], ['16', '16'], ['32', '32']], v => x => ({ ...x, maxSubagents: Number(v) }))}
        {sel('s-stale', 'Stale after', String(s.staleMinutes), [['5', '5 min'], ['10', '10 min'], ['20', '20 min'], ['30', '30 min'], ['60', '60 min']], v => x => ({ ...x, staleMinutes: Number(v) }))}
      </Box>
      <Box flexDirection="row" gap="xs" flexWrap="wrap">
        {toggle('s-simple', 'Simplified graph', s.simplified, x => ({ ...x, simplified: !x.simplified }))}
        {toggle('s-prs', 'PR nodes', s.showPRs, x => ({ ...x, showPRs: !x.showPRs }))}
        {toggle('s-pause', 'Pause live updates', s.paused, x => ({ ...x, paused: !x.paused }))}
      </Box>
      <Box flexDirection="row" gap="xs" flexWrap="wrap">
        <Button key="s-reset-layout" label="Reset layout" dimColor onPress={() => void updatePrefs($, p => ({ ...p, positions: {}, collapsed: [] })).then(() => tick($, true))} />
        <Button key="s-refresh-now" label="Refresh" dimColor onPress={() => void tick($, true)} />
        <Button key="s-diag" label="Diagnostics" dimColor onPress={() => void setView($, 'diag')} />
        {!ui.confirmClear ? (
          <Button key="s-clear" label="Clear data…" dimColor onPress={() => void setUi($, u => ({ ...u, confirmClear: true }))} />
        ) : (
          <Button
            key="s-clear-yes"
            label="Delete history and settings"
            variant="primary"
            onPress={() => void clearData($).then(r => setUi($, u => ({ ...u, confirmClear: false, notice: r.ok ? 'Stored data cleared.' : `Clear failed: ${r.message}` })))}
          />
        )}
        {ui.confirmClear && <Button key="s-clear-no" label="Cancel" dimColor onPress={() => void setUi($, u => ({ ...u, confirmClear: false }))} />}
      </Box>
    </Box>
  )
}

function DiagView($: EngineInterface, c: PaneContext): RenderElement {
  const { t, snapshot, diag, now, ui } = c
  const { Box, Text, Button } = t
  const src = snapshot?.sources
  const lines = [
    `Role: ${diag.role} · ticks ${diag.ticks} · last tick ${diag.lastTickAt ? since(now - diag.lastTickAt) : 'never'} (${diag.lastTickMs} ms)`,
    `This session: ${app.me || 'unknown'} · entrypoint ${app.entrypoint ?? 'unknown'} · publishing ${isPublishing() ? 'yes' : 'no'} (${diag.publishWrites} writes)`,
    `Snapshot: ${snapshot ? `made ${since(now - snapshot.generatedAt)}, Orbit ${snapshot.serverVersion} server, snapshot ${snapshot.seq}, ${diag.snapshotBytes} bytes, aggregate ${snapshot.timings.aggregateMs} ms, layout ${snapshot.timings.layoutMs} ms` : 'none yet'}`,
    `Graph SVG: ${app.lastSvgChars} chars (pane limit 131,072)`,
    `Rate limits: ${limitsView(snapshot?.usage, now)?.parts.map(p => `${p.text}${p.resets ? ` (resets ${p.resets})` : ''}`).join(', ') ?? 'none reported'}`,
    `Pane renders: ${app.renders}, last ${app.lastRenderMs} ms, average ${app.renders ? Math.round(app.renderMsTotal / app.renders) : 0} ms, slowest ${app.renderMsMax} ms (also in this session's record)`,
    src
      ? `Desktop records: ${src.desktop.ok ? 'ok' : `unavailable (${src.desktop.error ?? 'unknown'})`} · ${src.desktop.files} files, ${src.desktop.parsed} parsed, ${src.desktop.failed} unreadable`
      : 'Desktop records: —',
    src ? `Session publishers: ${src.publishers.files} files, ${src.publishers.live} live, ${src.publishers.failed} unreadable` : 'Session publishers: —',
    src ? `Subagents: ${src.subagents.metas} tracked, ${src.subagents.failed} unreadable metadata files` : 'Subagents: —',
    armLine(diag.armed),
    noticeLine(diag.notice),
    errorsLine(diag.errors, now),
    `Pop-out window: ${diag.companion ?? 'not connected'}`,
    `Replies from Orbit (this session): ${inboxSummary(diag.inbox, now)}`,
    `Data folder: ${app.paths?.data ?? 'unknown'}`,
    diag.lastError ? `Last load error: ${diag.lastError}` : 'Last load error: none',
    ...(src?.errors ?? []).slice(0, 5).map(e => `Source error: ${e}`),
  ]
  return (
    <Box flexDirection="column" gap="xs">
      {BackRow($, c, 'diag', 'Diagnostics')}
      {lines.map((line, i) => (
        <Text key={`dg-${i}`} size="footnote" mono>
          {line}
        </Text>
      ))}
      <Box flexDirection="row" gap="xs">
        <Button key="dg-refresh" label="Refresh" dimColor onPress={() => void tick($, true)} />
      </Box>
    </Box>
  )
}

function EmptyState($: EngineInterface, c: PaneContext): RenderElement {
  const { t, prefs } = c
  const { Box, Text, Button } = t
  return (
    <Box flexDirection="column" gap="xs">
      <Text dimColor>No sessions match these filters.</Text>
      <Box flexDirection="row" gap="xs">
        <Button key="empty-reset" label="Reset filters" onPress={() => void setFilters($, () => ({ ...DEFAULT_FILTERS }))} />
        {prefs.filters.time !== 'all' && <Button key="empty-all" label="Show all time" dimColor onPress={() => void setFilters($, x => ({ ...x, time: 'all' }))} />}
      </Box>
    </Box>
  )
}

function LoadingState($: EngineInterface, c: PaneContext): RenderElement {
  const { t, diag } = c
  const { Box, Text, Button } = t
  if (!diag.lastError) return <Text dimColor>Loading sessions…</Text>
  return (
    <Box flexDirection="column" gap="xs">
      <Text>Could not load sessions: {diag.lastError}</Text>
      <Box flexDirection="row" gap="xs">
        <Button key="load-retry" label="Refresh" onPress={() => void tick($, true)} />
        <Button key="load-diag" label="Diagnostics" dimColor onPress={() => void setView($, 'diag')} />
      </Box>
    </Box>
  )
}

type Triage = 'done' | 'snooze-hour' | 'snooze-tomorrow' | 'hide'

/** How long a Done, Snooze or Hide stays undoable, as the page's toast. */
const UNDO_MS = 8_000

/** The last Done, Snooze or Hide, undoable while its notice shows (the page's toast). */
let undoable: { notice: string; change: (prefs: Prefs) => Prefs } | null = null

/** Done, Snooze or Hide through the shared prefs, as the page does, so the page, the pane and the counts agree; each with Undo. */
async function triage($: EngineInterface, action: Triage, s: SessionView): Promise<void> {
  const now = await $.clock.now()
  const title = `“${truncate(s.title, 40)}”`
  let change: (prefs: Prefs) => Prefs
  let undo: (prefs: Prefs) => Prefs
  let text: string
  if (action === 'done') {
    change = p => applyMarks(p, donePatch(s.key, now))
    undo = p => applyMarks(p, donePatch(s.key, null))
    text = `${title} marked done.`
  } else if (action === 'hide') {
    if (bucketOf(s) === 'needs-you') return void setUi($, u => ({ ...u, notice: 'A session that needs you can’t be hidden: use Done or Snooze.' }))
    change = p => applyMarks(p, { hidden: { ...p.hidden, [s.key]: s.lastActivityAt } })
    undo = p => applyMarks(p, { hidden: Object.fromEntries(Object.entries(p.hidden ?? {}).filter(([k]) => k !== s.key)) })
    text = `${title} hidden until it is active again.`
  } else {
    const until = snoozeUntil(action === 'snooze-hour' ? 'hour' : 'tomorrow', now)
    change = p => applyMarks(p, snoozePatch(s.key, until, now))
    undo = p => applyMarks(p, snoozePatch(s.key, null, now))
    text = `${title} snoozed until ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${action === 'snooze-tomorrow' ? ' tomorrow' : ''}.`
  }
  const error = await updatePrefs($, change)
  if (error) {
    undoable = null
    await setUi($, u => ({ ...u, notice: `Couldn’t ${action === 'done' ? 'mark it done' : action === 'hide' ? 'hide it' : 'snooze it'}. Try again.` }))
    return
  }
  undoable = { notice: text, change: undo }
  await setUi($, u => ({ ...u, notice: text }))
  void tick($, true)
  $.clock.after(UNDO_MS, () => {
    if (undoable?.notice !== text) return
    undoable = null
    void setUi($, u => (u.notice === text ? { ...u, notice: null } : u))
  })
}

async function runUndo($: EngineInterface): Promise<void> {
  const last = undoable
  undoable = null
  if (!last) return
  const error = await updatePrefs($, last.change)
  await setUi($, u => ({ ...u, notice: error ? 'Couldn’t undo it. Try again.' : null }))
  if (!error) void tick($, true)
}

/** n: the next session that needs you after the one selected (longest waiting first), opened in its details, as the page does. */
async function openNextNeed($: EngineInterface, queue: Queue, selected: string | null): Promise<void> {
  const keys = queue.find(g => g.key === 'needs-you')?.rows.map(s => s.key) ?? []
  if (keys.length === 0) return
  const at = keys.findIndex(key => `s:${key}` === selected)
  await selectNode($, `s:${keys[(at + 1) % keys.length]}`, 'detail')
}

/** The page's session actions (card and panel): Done, Snooze 1 hour, Snooze until tomorrow, and Hide except on a session that needs you. */
function TriageButtons($: EngineInterface, c: PaneContext, s: SessionView, where: 'card' | 'detail'): RenderElement {
  const { Box, Button } = c.t
  return (
    <Box flexDirection="row" gap="xs" flexWrap="wrap">
      <Button key={`${where}-done`} label="Done" hotkey="d" onPress={() => void triage($, 'done', s)} />
      <Button key={`${where}-snooze`} label="Snooze 1 hour" hotkey="s" onPress={() => void triage($, 'snooze-hour', s)} />
      <Button key={`${where}-snooze-tomorrow`} label="Snooze until tomorrow" onPress={() => void triage($, 'snooze-tomorrow', s)} />
      {bucketOf(s) !== 'needs-you' && <Button key={`${where}-hide`} label="Hide" hotkey="h" onPress={() => void triage($, 'hide', s)} />}
    </Box>
  )
}

/** A session's state in words: the server's status reason (D-4), else the lifecycle wording. */
function statusReason(s: SessionView, now: number): string {
  return s.status?.reason || stateText(s, now)
}

export function renderPane($: EngineInterface, input: PaneInput): RenderElement {
  const context = input.snapshot ? { ...input, snapshot: withLocalMarks(input.snapshot, input.prefs, input.now) } : input
  const { t, snapshot, prefs, ui, now } = context
  const { Box, Text, Button } = t
  const visible = snapshot ? visibleOf(snapshot, prefs.filters, prefs.settings, prefs.collapsed, now, { pinned: prefs.pinned, hidden: prefs.hidden, keepNeedsYouInProject: true }) : null
  const queue = visible ? queueGroups(listedSessions(visible), now) : []
  const c: PaneContext = { ...context, peers: visible?.peers ?? {} }
  const projects = new Map((snapshot?.projects ?? []).map(p => [p.id, p]))

  let body: RenderElement | null = null
  if (ui.view === 'settings') body = SettingsView($, c, visible)
  else if (ui.view === 'new') body = NewSessionView($, c)
  else if (ui.view === 'diag') body = DiagView($, c)
  else if (!snapshot || !visible) body = LoadingState($, c)
  else if (ui.view === 'detail') {
    const id = ui.selected ?? ''
    const session = id.startsWith('s:') ? snapshot.sessions.find(s => `s:${s.key}` === id) : undefined
    const agent = id.startsWith('a:') ? snapshot.agents.find(a => `a:${a.key}` === id) : undefined
    const project = id.startsWith('p:') ? snapshot.projects.find(p => `p:${p.id}` === id) : undefined
    body = session ? (
      SessionDetail($, c, session, snapshot)
    ) : agent ? (
      AgentDetail($, c, agent, snapshot)
    ) : project ? (
      ProjectDetail($, c, project, snapshot, projects)
    ) : (
      <Text dimColor>That item is no longer in the snapshot.</Text>
    )
  } else {
    const isGraph = ui.view === 'graph'
    body = (
      <Box flexDirection="column" gap={1}>
        {FilterNote($, c, visible.hiddenCount)}
        {isGraph && NeedsYouQueue($, c, queue)}
        {visible.sessions.length === 0 && visible.attention.length === 0 && (isGraph || visible.pinned.length === 0)
          ? EmptyState($, c)
          : isGraph
            ? GraphView($, c, visible, snapshot)
            : QueueView($, c, queue, projects, true)}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      {Header($, c, queue)}
      {ui.notice && (
        <Box flexDirection="row" gap="xs" alignItems="center" flexWrap="wrap">
          <Text size="footnote" dimColor>
            {ui.notice}
          </Text>
          {undoable && undoable.notice === ui.notice && <Button key="undo" label="Undo" hotkey="u" dimColor onPress={() => void runUndo($)} />}
        </Box>
      )}
      {context.diag.notice && ui.view !== 'diag' && (
        <Text size="footnote">
          {context.diag.notice}
        </Text>
      )}
      {prefs.settings.paused && (
        <Text size="footnote" dimColor>
          Live updates paused.
        </Text>
      )}
      {body}
    </Box>
  )
}
