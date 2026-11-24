import { listedSessions } from '/shared/map.js'
import { createMapView } from './map-view.js'

export const WANTS_METRICS = new URLSearchParams(location.search).get('metrics') === '1'

export const view = createMapView()

export const ZOOM_STEP = 1.15
export const PAN_STEP = 0.1
export const CLICK_SLOP_PX = 4
export const TOUCH_SLOP_PX = 10
export const HIT_SLACK_PX = 14
export const HEALTH_EVERY_MS = 10_000
export const SETTLE_MS = 150

export const $ = id => document.getElementById(id)
export const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.className = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : String(v))
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child)
  return node
}
export const remember = (key, value) => {
  try {
    localStorage.setItem(`orbit.${key}`, JSON.stringify(value))
  } catch {}
}
export const stored = (key, fallback) => {
  try {
    const raw = localStorage.getItem(`orbit.${key}`)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

export const state = {
  snapshot: null,
  stageW: 0,
  stageH: 0,
  stageLeft: 0,
  view: 'map',
  nodeDrag: false,
  prefs: null,
  stamps: null,
  checkedAt: null,
  visible: null,
  lookup: null,
  camera: null,
  selected: null,
  connected: false,
  droppedAt: null,
  isClosed: false,
  everAnswered: false,
  acceptedAt: null,
  loadFailures: 0,
  loadError: null,
  health: null,
  arm: null,
  armStamp: undefined,
  placement: new Map(),
  isMoved: false,
  filterSig: null,
  fitBase: null,
  layoutKey: null,
  query: '',
  matches: new Set(),
  focusNode: null,
  cardKey: null,
  cameraTarget: null,
  pendingFit: false,
  unlabelledNeedsYou: 0,
  overrideErrors: new Map(),
  alerts: [],
  alertStamp: undefined,
  invoker: null,
  convo: { key: null },
  shell: null,
  windowId: null,
  lastInputAt: 0,
  approvalsStamp: undefined,
}

export async function post(route, body) {
  const res = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (res.status === 403) state.isClosed = true
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw Object.assign(new Error(detail?.error ?? `${route}: ${res.status}`), { status: res.status, detail })
  }
  return res.json()
}

export async function api(route) {
  const res = await fetch(route)
  if (res.status === 403) state.isClosed = true
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw Object.assign(new Error(detail?.error ?? `${route}: ${res.status}`), { status: res.status })
  }
  return res.json()
}

export function visibleSessions() {
  return listedSessions(state.visible)
}

/** Where an apply's time goes, by phase, for `orbitMetrics().applyPhases` (the harness reads it; nothing else does). */
export const applyPhases = {}
export function applyPhase(name, startedAt) {
  applyPhases[name] = Math.round((performance.now() - startedAt) * 10) / 10
}
