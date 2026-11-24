import { atom, read } from 'claude-code'
import type { CommandRunInput, CommandRunResult, EngineInterface, Register } from 'claude-code'

import { app, appEnd, appStart, openPane, paneSnapshot, popOut, recordRender, tick } from '../src/app'
import { inboxTurn, steerReplies } from '../src/core/inbox'
import { askBoth } from '../src/core/questions'
import { errorText } from '../src/paths'
import { defaultPrefs } from '../src/core/prefs'
import { INITIAL_DIAG, INITIAL_UI, PANE, PANE_GRAPH_TIER, SHAPES } from '../src/state'
import {
  publishAgentSpawned,
  publishMeasure,
  publishModel,
  publishPermission,
  publishToolEnd,
  publishToolStart,
  publishTurnComplete,
  publishTurnStart,
  recordError,
} from '../src/telemetry/publisher'
import { openNew, renderPane, setView, type Table } from '../src/ui/pane'

const versionAtom = atom({ plugin: 'orbit', key: 'snapshotVersion' } as const, { at: 0, n: 0 }, { shape: SHAPES.snapshotVersion })
const prefsAtom = atom({ plugin: 'orbit', key: 'prefs' } as const, defaultPrefs(), { shape: SHAPES.prefs })
const uiAtom = atom({ plugin: 'orbit', key: 'ui' } as const, INITIAL_UI, { shape: SHAPES.ui })
const diagAtom = atom({ plugin: 'orbit', key: 'diag' } as const, INITIAL_DIAG, { shape: SHAPES.diag })

const COMMAND = 'orbit'
const ARGS = '[list|graph|new|popout|diag]'

async function runCommand($: EngineInterface, e: CommandRunInput): Promise<CommandRunResult> {
  const arg = e.args.trim().toLowerCase()
  if (arg === 'popout') {
    const result = await popOut($)
    return { text: result.message }
  }
  await openPane($)
  if (arg === 'graph') await setView($, 'graph')
  else if (arg === 'diag') await setView($, 'diag')
  else if (arg === 'new') await openNew($, null)
  else if (arg === 'list') await setView($, 'list')
  void tick($, true)
  return { text: 'Orbit opened.' }
}

async function observe($: EngineInterface, what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    $.ui.log(`orbit: ${what}: ${errorText(error)}`, { to: 'debug' })
    await recordError($, 'hook', error).catch(() => undefined)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await observe($, 'commands', async () => {
      await $.command.register({
        name: COMMAND,
        description: 'Orbit: live status of your Claude sessions and subagents, the constellation view, new sessions and the pop-out window',
        argumentHint: ARGS,
      })
    })
    void observe($, 'start', async () => {
      await appStart($, e)
      if (app.isDesktop) void openPane($)
    })
    return started
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    await observe($, 'end', () => appEnd($, e.reason))
    return ended
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) inboxTurn(true, e.turnId)
    void observe($, 'turn.start', () => publishTurnStart($, e.agentId))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) inboxTurn(false, e.turnId)
    void observe($, 'turn.complete', async () => {
      await publishTurnComplete($, e.agentId, e.reason)
      if (e.agentId === undefined) await publishModel($)
    })
    return result
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    void observe($, 'agent.spawn', () =>
      publishAgentSpawned($, { description: e.description, subagentType: e.subagentType, parentAgentId: e.parentAgentId }, result),
    )
    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const started = observe($, 'tool.call', () => publishToolStart($, String(e.tool), e.tool_use_id, input, e.agentId))
    const result = await next(e)
    const isError = ('isError' in result && result.isError === true) || ('deny' in result && typeof result.deny === 'string')
    void started.then(() => observe($, 'tool.result', () => publishToolEnd($, String(e.tool), e.tool_use_id, isError)))
    return result
  }).catch(($, e, next) => next(e))

  on('classic.PostToolBatch', async ($, e, next) => {
    const result = await next(e)
    if ((e as { agent_id?: unknown }).agent_id !== undefined) return result
    const steered = await steerReplies($).catch(() => [])
    return steered.length === 0 ? result : { ...result, additionalContext: [...(result.additionalContext ?? []), ...steered] }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) => askBoth($, e as unknown as Record<string, unknown>, () => next(e))).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    void observe($, 'session.measure', () => publishMeasure($, e))
    return result
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', ($, e, next) => {
    void observe($, 'permission', () => publishPermission($, e.tool_name))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', ($, e, next) => {
    if (e.notification_type === 'permission_prompt') void observe($, 'notification', () => publishPermission($, null))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, ($, e) => runCommand($, e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const started = Date.now()
    const table = $.ui.resolve(e) as unknown as Table
    await read($, versionAtom)
    const prefs = await read($, prefsAtom)
    const now = await $.clock.now()
    const snapshot = paneSnapshot(app.snapshot, prefs.positions, PANE_GRAPH_TIER, { filters: prefs.filters, pinned: prefs.pinned, now })
    const ui = await read($, uiAtom)
    const diag = ui.view === 'diag' || snapshot === null ? await read($, diagAtom) : app.diag
    if (!app.isTicking && app.paths && now - app.lastTickAt > prefs.settings.refreshSec * 1000) void tick($, false)
    const key = ui.view === 'diag' || snapshot === null ? null : renderKey(snapshot.generatedAt, prefs, ui, e.surface, e.props.bodyColumns, e.props.placement, now)
    if (key !== null && key === lastRender.key && lastRender.tree !== null) return lastRender.tree
    const tree = renderPane($, {
      t: table,
      surface: e.surface,
      snapshot,
      prefs,
      ui,
      diag,
      now,
      bodyColumns: e.props.bodyColumns,
      placement: e.props.placement,
    })
    lastRender.key = key
    lastRender.tree = tree
    recordRender(Date.now() - started, now)
    return tree
  })
}

const RENDER_BUCKET_MS = 15_000
const lastRender: { key: string | null; tree: ReturnType<typeof renderPane> | null } = { key: null, tree: null }

/**
 * What a pane drawing depends on: the snapshot by its time, the prefs and
 * pane state by value, the surface and size, and the time in 15 s steps
 * (relative ages on screen move no faster). Equal keys draw the same tree.
 */
function renderKey(generatedAt: number, prefs: unknown, ui: unknown, surface: string, columns: unknown, placement: unknown, now: number): string {
  return JSON.stringify([generatedAt, prefs, ui, surface, columns, placement, Math.floor(now / RENDER_BUCKET_MS)])
}
