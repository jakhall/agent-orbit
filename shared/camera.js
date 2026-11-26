// @ts-check

/** @typedef {{ x: number, y: number, w: number, h: number }} Camera */
/** @typedef {{ w: number, h: number }} Stage */

const MAX_PX_PER_UNIT = 4
const MIN_OF_FIT = 0.5

/**
 * Whether a change of filters should refit the camera: only when the filters
 * really changed and the person has not moved the camera since the last Fit.
 * @param {string | null} previous signature of the filters last drawn, null before the first draw
 * @param {string} next
 * @param {boolean} isMoved
 */
export function shouldRefit(previous, next, isMoved) {
  return previous !== null && previous !== next && !isMoved
}

/**
 * Whether a resized stage should refit the camera: only when the window itself
 * changed size and the person has not moved the camera since the last Fit. A
 * panel or column opening or closing inside the same window keeps the zoom.
 * @param {Stage} previousWindow the window's inner size at the last draw
 * @param {Stage} nextWindow
 * @param {boolean} isMoved
 */
export function shouldRefitOnResize(previousWindow, nextWindow, isMoved) {
  return !isMoved && (previousWindow.w !== nextWindow.w || previousWindow.h !== nextWindow.h)
}

/**
 * The part of the stage a selected session should be visible in: the stage
 * less the panel over its right side, less a band at the bottom (camera
 * controls, minimap), less a margin.
 * @param {Stage} stage
 * @param {{ panelLeft: number | null, reservedBottom: number, margin: number }} cover panelLeft in stage px from the stage's left, or null with no panel
 * @returns {Camera} in stage px
 */
export function safeArea(stage, cover) {
  const right = cover.panelLeft === null ? stage.w : Math.min(stage.w, cover.panelLeft)
  return { x: cover.margin, y: cover.margin, w: Math.max(0, right - 2 * cover.margin), h: Math.max(0, stage.h - cover.reservedBottom - 2 * cover.margin) }
}

/**
 * The camera that shows `point` (world) inside `safe` (stage px), panning
 * only when it is outside and to the safe area's centre; the same camera
 * object when no pan is needed. Never zooms.
 * @param {Camera} camera
 * @param {Stage} stage
 * @param {{ x: number, y: number }} point
 * @param {Camera} safe
 * @returns {Camera}
 */
export function focusPan(camera, stage, point, safe) {
  const k = stage.w / camera.w
  const sx = (point.x - camera.x) * k
  const sy = (point.y - camera.y) * k
  if (sx >= safe.x && sx <= safe.x + safe.w && sy >= safe.y && sy <= safe.y + safe.h) return camera
  return { ...camera, x: point.x - (safe.x + safe.w / 2) / k, y: point.y - (safe.y + safe.h / 2) / k }
}

/**
 * Zoom bounds in screen px per world unit: from half the fitted scale (the
 * whole map with room around it) to 4 px per unit.
 * @param {Camera} fit
 * @param {Stage} stage
 */
export function zoomLimits(fit, stage) {
  return { min: (stage.w / fit.w) * MIN_OF_FIT, max: MAX_PX_PER_UNIT }
}

/**
 * `camera` held within the zoom bounds, keeping its centre; the same object when already inside.
 * @param {Camera} camera
 * @param {Stage} stage
 * @param {{ min: number, max: number }} limits
 * @returns {Camera}
 */
export function clampZoom(camera, stage, limits) {
  const k = stage.w / camera.w
  const clamped = Math.min(limits.max, Math.max(limits.min, k))
  if (clamped === k) return camera
  const w = stage.w / clamped
  const h = stage.h / clamped
  return { x: camera.x + camera.w / 2 - w / 2, y: camera.y + camera.h / 2 - h / 2, w, h }
}

/** Ease-out cubic, 0 → 1. @param {number} t */
export function easeOut(t) {
  const c = Math.min(1, Math.max(0, t))
  return 1 - (1 - c) ** 3
}

/**
 * The camera `t` of the way from `from` to `to` (eased by the caller).
 * @param {Camera} from
 * @param {Camera} to
 * @param {number} t
 * @returns {Camera}
 */
export function tweenCamera(from, to, t) {
  if (t >= 1) return to
  if (t <= 0) return from
  const mix = (/** @type {number} */ a, /** @type {number} */ b) => a + (b - a) * t
  return { x: mix(from.x, to.x), y: mix(from.y, to.y), w: mix(from.w, to.w), h: mix(from.h, to.h) }
}

/**
 * The minimap for `nodes` in a box of `size` px: the scale and offset that
 * fit the whole map, the camera as a rectangle in minimap px (clipped to the
 * box), and a function from a minimap point back to the world.
 * @param {readonly { x: number, y: number, r: number }[]} nodes
 * @param {{ w: number, h: number }} size
 * @param {Camera} camera
 */
export function minimapView(nodes, size, camera) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.r)
    minY = Math.min(minY, n.y - n.r)
    maxX = Math.max(maxX, n.x + n.r)
    maxY = Math.max(maxY, n.y + n.r)
  }
  if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0
  const s = Math.min(size.w / Math.max(1, maxX - minX), size.h / Math.max(1, maxY - minY))
  const ox = (size.w - (maxX - minX) * s) / 2 - minX * s
  const oy = (size.h - (maxY - minY) * s) / 2 - minY * s
  const x0 = Math.max(0, camera.x * s + ox)
  const y0 = Math.max(0, camera.y * s + oy)
  const x1 = Math.min(size.w, (camera.x + camera.w) * s + ox)
  const y1 = Math.min(size.h, (camera.y + camera.h) * s + oy)
  return {
    scale: s,
    offset: { x: ox, y: oy },
    rect: { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) },
    toWorld: (/** @type {number} */ mx, /** @type {number} */ my) => ({ x: (mx - ox) / s, y: (my - oy) / s }),
  }
}

/**
 * The camera zoomed by `factor` (new width / old width) around `at` (world),
 * with the factor clamped so the zoom stays within `limits`: the point under
 * the pointer stays where it is, even at a limit (the same object when no zoom is left).
 * @param {Camera} camera
 * @param {Stage} stage
 * @param {{ x: number, y: number }} at
 * @param {number} factor
 * @param {{ min: number, max: number }} limits
 * @returns {Camera}
 */
export function zoomAround(camera, stage, at, factor, limits) {
  const k = stage.w / camera.w
  const target = Math.min(limits.max, Math.max(limits.min, k / factor))
  if (target === k) return camera
  const f = k / target
  const w = camera.w * f
  const h = camera.h * f
  return { x: at.x - ((at.x - camera.x) / camera.w) * w, y: at.y - ((at.y - camera.y) / camera.h) * h, w, h }
}
