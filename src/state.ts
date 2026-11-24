import type { Diag, PaneUi } from '../types'

export const PANE = 'orbit'

/** Each state atom's shape tag, one place for every file that declares the atom (E-63); bump here when a value's meaning changes. */
/** The pane graph draws the overview and sessions tiers only (C10): no sub-agent satellites. */
export const PANE_GRAPH_TIER = 1

export const SHAPES = { snapshotVersion: 'snapver-1', prefs: 'prefs-3', ui: 'ui-2', diag: 'diag-2' } as const

export const INITIAL_UI: PaneUi = {
  view: 'list',
  previousView: 'list',
  selected: null,
  focus: null,
  camera: { zoom: 1, panX: 0, panY: 0 },
  filtersOpen: false,
  confirmClear: false,
  notice: null,
  openingKey: null,
  create: { status: 'editing', message: null, revision: 0 },
}

export const INITIAL_DIAG: Diag = {
  role: 'idle',
  lastTickAt: 0,
  lastTickMs: 0,
  lastError: null,
  snapshotBytes: 0,
  ticks: 0,
  publishWrites: 0,
  companion: null,
}
