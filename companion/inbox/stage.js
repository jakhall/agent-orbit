import { canFirstFit, statusOf } from '/shared/popout.js'
import { fitMap, hexagonPoints, mapParts } from '/shared/map.js'
import { clampZoom, easeOut, focusPan, minimapView, safeArea, tweenCamera, zoomAround, zoomLimits } from '/shared/camera.js'
import { $, applyPhase, SETTLE_MS, state, view, visibleSessions, WANTS_METRICS } from './page-state.js'
import { emptyText, noSnapshotText, stateBlock } from './rail.js'
import { hideCard } from './card.js'

/**
 * The rectangles the map reads (stage, panel, camera controls, minimap),
 * kept until one of them changes: reading them right after the queue or the
 * header changed would force a second layout of the whole page per apply.
 */
const geometry = { valid: false, rects: new Map() }

export function invalidateGeometry() {
  geometry.valid = false
}

function rectOf(name, read) {
  if (!geometry.valid) {
    geometry.rects.clear()
    geometry.valid = true
  }
  if (!geometry.rects.has(name)) geometry.rects.set(name, read())
  return geometry.rects.get(name)
}

export function stageBox() {
  return rectOf('stage', () => $('cx-stage').getBoundingClientRect())
}

/** Fit margin in px; the bottom keeps the camera buttons (and, at density, the minimap) clear. */
const FIT_PAD = { top: 32, right: 32, bottom: 88, left: 32 }
const FIT_PAD_MINIMAP = { ...FIT_PAD, bottom: 120 }
const CONTROL_CLEARANCE_PX = 6
const MINIMAP_SESSIONS = 50
const MINIMAP_ZOOM_OF_FIT = 1.6
const TRANSITION_MS = 200
export const SAFE_MARGIN_PX = 24
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

/** Map animation Low or Normal is the person asking for motion, so it overrides the system's reduced-motion request (the map draw marks `<html>` with `motion-always` for the CSS rules). */
function wantsMotion() {
  const animation = state.prefs?.settings?.animation
  return animation === 'low' || animation === 'normal'
}

/** True when the page should stay still: the system asks for reduced motion and Map animation is Off. */
function isMotionReduced() {
  return reducedMotion.matches && !wantsMotion()
}

export function framedNodes() {
  return (state.visible?.nodes ?? []).filter(n => n.kind === 'session' || n.kind === 'project' || n.kind === 'agent')
}

export function fitTarget() {
  const box = stageBox()
  const pad = visibleSessions().length > MINIMAP_SESSIONS ? FIT_PAD_MINIMAP : FIT_PAD
  const camera = fitMap(framedNodes(), { w: box.width || 1, h: box.height || 1 }, pad)
  state.fitBase = camera
  return camera
}

function fitCamera() {
  state.camera = fitTarget()
  state.isMoved = false
}

export function stageSize() {
  const box = stageBox()
  return { w: box.width || 1, h: box.height || 1 }
}

function limited(camera) {
  return clampZoom(camera, stageSize(), zoomLimits(state.fitBase ?? camera, stageSize()))
}

let animation = 0
/** Where the camera is going: the end of a running transition, else where it is. Steps and focus start from here, so quick presses don't shrink. */
export function cameraGoal() {
  return state.cameraTarget ?? state.camera
}

/** Moves the camera to `target` over 200 ms, eased (at once under reduced motion), then draws it; labels hide while it moves and fade back in after. Used for Fit, focus-on-select and the minimap; keys and buttons draw at once. */
export function animateTo(target) {
  hideCard()
  const from = state.camera
  const token = ++animation
  state.cameraTarget = target
  const finish = () => {
    if (token !== animation) return
    animation += 1
    state.cameraTarget = null
    state.camera = target
    const wasTweening = view.element.classList.contains('is-tweening')
    view.element.classList.remove('is-tweening')
    if (wasTweening) view.element.classList.add('is-revealing')
    renderMap()
    if (!wasTweening) return
    const reveal = () => view.element.classList.remove('is-revealing')
    requestAnimationFrame(reveal)
    setTimeout(reveal, 50)
  }
  if (!from || isMotionReduced()) return finish()
  view.element.classList.add('is-tweening')
  if (WANTS_METRICS) {
    frames.until = performance.now() + TRANSITION_MS + 100
    if (frames.last === 0) requestAnimationFrame(sampleFrames)
  }
  const start = performance.now()
  const step = now => {
    if (token !== animation) return
    const t = (now - start) / TRANSITION_MS
    if (t >= 1) return finish()
    state.camera = tweenCamera(from, target, easeOut(t))
    view.preview(state.camera)
    renderMinimapRect()
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
  setTimeout(finish, TRANSITION_MS + 60)
}

/** Ends a running transition where it is going, so a direct move (wheel, drag, key) starts from there. */
export function settleAnimation() {
  if (!state.cameraTarget) return
  animation += 1
  state.camera = state.cameraTarget
  state.cameraTarget = null
  view.element.classList.remove('is-tweening')
}

/** The panel's left edge over the stage, in stage px, or null when it is closed or beside it. */
export function panelLeft() {
  const panel = $('cx-panel')
  if (panel.hidden) return null
  const p = rectOf('panel', () => panel.getBoundingClientRect())
  const s = stageBox()
  return p.left < s.right && p.right > s.left ? p.left - s.left : null
}

export function reservedBottom() {
  const s = stageBox()
  const tops = [['minimap', $('cx-minimap')], ['controls', document.querySelector('.cx-camera')], ['legend', $('cx-legend')]].filter(([, e]) => e && !e.hidden).map(([name, e]) => rectOf(name, () => e.getBoundingClientRect()).top)
  const top = Math.min(...tops, s.bottom)
  return Math.max(0, s.bottom - top + CONTROL_CLEARANCE_PX)
}

/** Brings the selected session into view beside the panel when it is out of sight; pans only, never zooms. */
export function focusSelected() {
  const node = state.visible?.nodes.find(n => n.id === state.selected)
  if (!node || !state.camera || state.view === 'conversation') return
  const safe = safeArea(stageSize(), { panelLeft: panelLeft(), reservedBottom: reservedBottom(), margin: SAFE_MARGIN_PX })
  const goal = cameraGoal()
  const next = focusPan(goal, stageSize(), node, safe)
  if (next !== goal) animateTo(next)
}

/** Shows or hides the minimap before a redraw, so labels are placed clear of it from its first frame. */
function updateMinimapShown() {
  const box = $('cx-minimap')
  const shown = minimapShown()
  if (box.hidden !== !shown) {
    box.hidden = !shown
    invalidateGeometry()
  }
}

function minimapShown() {
  if (!state.camera || !state.fitBase) return false
  return visibleSessions().length > MINIMAP_SESSIONS || state.fitBase.w / state.camera.w > MINIMAP_ZOOM_OF_FIT
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const MINIMAP_HUB_R = 4
const MINIMAP_PAD = 6
export let minimapModel = null

/** `minimapView` inset by `MINIMAP_PAD`, so hubs and needs-you dots at the map's edge are drawn whole; drawing, the view rectangle and clicks all use it. */
function minimapFrame(nodes) {
  const p = MINIMAP_PAD
  const m = minimapView(nodes, { w: 160 - 2 * p, h: 96 - 2 * p }, state.camera)
  return {
    scale: m.scale,
    offset: { x: m.offset.x + p, y: m.offset.y + p },
    rect: { ...m.rect, x: m.rect.x + p, y: m.rect.y + p },
    toWorld: (/** @type {number} */ x, /** @type {number} */ y) => m.toWorld(x - p, y - p),
  }
}

/** The minimap: the map's shape (faint spokes, a small hub hexagon per project, a neutral dot per session), sessions that need you as amber points on top, and the view as a rectangle. */
function renderMinimap() {
  const box = $('cx-minimap')
  updateMinimapShown()
  if (box.hidden) return
  const nodes = framedNodes()
  const size = { w: 160, h: 96 }
  minimapModel = minimapFrame(nodes)
  const { scale: s, offset: o } = minimapModel
  const mx = n => (n.x * s + o.x).toFixed(1)
  const my = n => (n.y * s + o.y).toFixed(1)
  const projects = new Map(nodes.filter(n => n.kind === 'project').map(n => [n.id, n]))
  const sessions = nodes.filter(n => n.kind === 'session')
  const needsYou = sessions.filter(n => statusOf(state.lookup?.sessions.get(n.ref) ?? {}).bucket === 'needs-you')
  const parts = []
  for (const n of sessions) {
    const hub = projects.get(n.parent)
    if (hub) parts.push(`<line x1="${mx(hub)}" y1="${my(hub)}" x2="${mx(n)}" y2="${my(n)}" stroke="var(--line-strong)" stroke-width="0.75"/>`)
  }
  for (const p of projects.values()) parts.push(`<polygon points="${hexagonPoints(MINIMAP_HUB_R)}" transform="translate(${mx(p)} ${my(p)})" fill="var(--bg2)" stroke="var(--control-edge)" stroke-width="1"/>`)
  for (const n of sessions) parts.push(`<circle cx="${mx(n)}" cy="${my(n)}" r="1.25" fill="var(--dim)"/>`)
  parts.push('<rect id="cx-minimap-view" fill="none" stroke="var(--accent)" stroke-width="1.5"/>')
  for (const n of needsYou) parts.push(`<circle cx="${mx(n)}" cy="${my(n)}" r="2" fill="var(--amber)"/>`)
  box.innerHTML = `<svg viewBox="0 0 ${size.w} ${size.h}" width="100%" height="100%" aria-hidden="true">${parts.join('')}</svg>`
  const inView = sessions.filter(n => n.x >= state.camera.x && n.x <= state.camera.x + state.camera.w && n.y >= state.camera.y && n.y <= state.camera.y + state.camera.h).length
  const needs = needsYou.length
  box.setAttribute('aria-label', `Overview of all ${sessions.length} sessions${needs ? `, ${needs} need you` : ''}; the view shows ${inView}. Click to move the view there.`)
  renderMinimapRect()
}

function renderMinimapRect() {
  const rect = document.getElementById('cx-minimap-view')
  if (!rect || !minimapModel || $('cx-minimap').hidden) return
  const nodes = framedNodes()
  const r = minimapFrame(nodes).rect
  rect.setAttribute('x', String(r.x))
  rect.setAttribute('y', String(r.y))
  rect.setAttribute('width', String(Math.max(2, r.w)))
  rect.setAttribute('height', String(Math.max(2, r.h)))
}

export function renderMap() {
  if (state.view === 'conversation' || state.nodeDrag) return
  const stage = $('cx-stage')
  const nodes = state.visible?.nodes ?? []
  const sessions = visibleSessions().length
  stage.setAttribute('aria-label', `Session map, ${sessions} ${sessions === 1 ? 'session' : 'sessions'}. Arrow keys move between sessions, Enter opens one, Shift+arrows pan, plus and minus zoom, 0 fits, n goes to the next that needs you, / searches. With a screen reader, use the queue: it lists the same sessions.`)
  if (!state.snapshot) {
    stage.replaceChildren(stateBlock(noSnapshotText(), Boolean(state.loadError)))
    return
  }
  if (nodes.length === 0) {
    stage.replaceChildren(stateBlock(emptyText(), false))
    return
  }
  const geometryStart = performance.now()
  const box = stageBox()
  const aspect = box.width > 0 && box.height > 0 ? box.width / box.height : 1.6
  if (!state.camera && !canFirstFit(state.camera, box)) return
  const isResized = state.stageW > 0 && box.width > 0 && (Math.abs(box.width - state.stageW) > 0.5 || Math.abs(box.height - state.stageH) > 0.5)
  let isRefit = false
  if (state.camera && isResized && !state.isMoved && !state.cameraTarget) {
    fitCamera()
    isRefit = true
  } else if (state.camera && state.stageW > 0 && box.width > 0 && (isResized || Math.abs(box.left - state.stageLeft) > 0.5)) {
    const perPx = state.camera.w / state.stageW
    state.camera = { ...state.camera, x: state.camera.x + (box.left - state.stageLeft) * perPx, w: box.width * perPx }
  }
  if (box.width > 0) {
    state.stageW = box.width
    state.stageH = box.height
    state.stageLeft = box.left
  }
  if (!state.camera) fitCamera()
  else if (Math.abs(state.camera.w / state.camera.h - aspect) > 0.01) {
    const cy = state.camera.y + state.camera.h / 2
    state.camera = { ...state.camera, y: cy - state.camera.w / aspect / 2, h: state.camera.w / aspect }
  }
  if (view.element.parentNode !== stage) stage.replaceChildren(view.element)
  updateMinimapShown()
  const controls = rectOf('controls', () => document.querySelector('.cx-camera')?.getBoundingClientRect())
  const minimap = $('cx-minimap').hidden ? null : rectOf('minimap', () => $('cx-minimap').getBoundingClientRect())
  const legend = $('cx-legend').hidden ? null : rectOf('legend', () => $('cx-legend').getBoundingClientRect())
  const panel = $('cx-panel').hidden ? null : rectOf('panel', () => $('cx-panel').getBoundingClientRect())
  const overPanel = panel && panel.left < box.right ? { left: panel.left, top: box.top, width: box.right - panel.left, height: box.height } : null
  const reserved = [controls, minimap, legend, overPanel].filter(Boolean).map(r => ({ x: r.left - box.left - CONTROL_CLEARANCE_PX, y: r.top - box.top - CONTROL_CLEARANCE_PX, w: r.width + 2 * CONTROL_CLEARANCE_PX, h: r.height + 2 * CONTROL_CLEARANCE_PX }))
  applyPhase('map.geometry', geometryStart)
  const partsStart = performance.now()
  document.documentElement.classList.toggle('motion-always', wantsMotion())
  document.documentElement.classList.toggle('pulse-working', state.prefs?.settings?.animation === 'normal')
  const parts = mapParts(nodes, state.visible.edges, state.lookup, {
    camera: state.camera,
    stagePx: { w: box.width || 1, h: box.height || 1 },
    selected: state.selected,
    reserved,
    previous: state.placement,
    pinned: new Set(state.prefs?.pinned ?? []),
    now: Date.now(),
    overflow: state.visible.overflow,
    focused: state.focusNode ? `s:${state.focusNode}` : null,
    matches: new Set([...state.matches].map(key => `s:${key}`)),
    animation: state.prefs?.settings?.animation ?? 'off',
  })
  applyPhase('map.parts', partsStart)
  state.placement = parts.placement
  state.unlabelledNeedsYou = parts.unlabelledNeedsYou
  const viewStart = performance.now()
  view.update(parts, state.camera)
  applyPhase('map.view', viewStart)
  const minimapStart = performance.now()
  renderMinimap()
  applyPhase('map.minimap', minimapStart)
  state.labels = parts.labels
  if (isRefit && state.selected) focusSelected()
}

let frame = 0
export let settleTimer = 0
export const frames = { times: [], last: 0, until: 0 }
function sampleFrames() {
  const now = performance.now()
  if (frames.last) frames.times.push(now - frames.last)
  if (frames.times.length > 240) frames.times.shift()
  frames.last = now
  if (now < frames.until) requestAnimationFrame(sampleFrames)
  else frames.last = 0
}

export function moveCamera(next) {
  hideCard()
  settleAnimation()
  state.isMoved = true
  state.camera = next
  if (WANTS_METRICS) {
    const isIdle = frames.last === 0
    frames.until = performance.now() + 300
    if (isIdle) requestAnimationFrame(sampleFrames)
  }
  if (!frame) {
    frame = requestAnimationFrame(() => {
      frame = 0
      view.preview(state.camera)
      renderMinimapRect()
    })
  }
  clearTimeout(settleTimer)
  settleTimer = setTimeout(renderMap, SETTLE_MS)
}

export function zoomAt(factor, at = null) {
  const c = cameraGoal()
  if (!c) return
  const p = at ?? { x: c.x + c.w / 2, y: c.y + c.h / 2 }
  const next = zoomAround(c, stageSize(), p, factor, zoomLimits(state.fitBase ?? c, stageSize()))
  if (next === c) return
  if (at) moveCamera(next)
  else stepCamera(next)
}

export function panBy(fx, fy) {
  const c = cameraGoal()
  if (c) stepCamera({ ...c, x: c.x + fx * c.w, y: c.y + fy * c.h })
}

/** A discrete camera step (a button or key): drawn at once, never previewed then redrawn. */
function stepCamera(next) {
  hideCard()
  clearTimeout(settleTimer)
  settleAnimation()
  state.isMoved = true
  state.camera = limited(next)
  renderMap()
}

export function toWorld(clientX, clientY) {
  const box = stageBox()
  const c = state.camera
  return { x: c.x + ((clientX - box.left) / box.width) * c.w, y: c.y + ((clientY - box.top) / box.height) * c.h, perPx: c.w / box.width }
}

export function fitAndRender() {
  clearTimeout(settleTimer)
  state.isMoved = false
  animateTo(fitTarget())
}
