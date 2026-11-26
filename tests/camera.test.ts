import { expect, test } from 'claude-code/testing'

import { clampZoom, easeOut, focusPan, minimapView, safeArea, shouldRefit, shouldRefitOnResize, tweenCamera, zoomAround, zoomLimits } from '../shared/camera.js'

const STAGE = { w: 1000, h: 600 }
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps

test('C4: Fit follows a filter change only while the person has not moved the camera; Fit clears that', () => {
  expect(shouldRefit('a', 'b', false)).toBe(true)
  expect(shouldRefit('a', 'b', true)).toBe(false)
  expect(shouldRefit('a', 'a', false)).toBe(false)
  expect(shouldRefit(null, 'a', false)).toBe(false)
})

test('2.4.1: after Fit, a resized window refits, but the panel opening on select keeps the zoom (Jak 2026-11-25)', () => {
  const win = { w: 1600, h: 900 }
  expect(shouldRefitOnResize(win, win, false)).toBe(false)
  expect(shouldRefitOnResize(win, { w: 1400, h: 900 }, false)).toBe(true)
  expect(shouldRefitOnResize(win, { w: 1600, h: 800 }, false)).toBe(true)
  expect(shouldRefitOnResize(win, { w: 1400, h: 900 }, true)).toBe(false)
})

test('C4: the safe area is the stage less the panel over it, the reserved corner and a margin', () => {
  expect(safeArea(STAGE, { panelLeft: null, reservedBottom: 0, margin: 24 })).toEqual({ x: 24, y: 24, w: 952, h: 552 })
  expect(safeArea(STAGE, { panelLeft: 600, reservedBottom: 100, margin: 24 })).toEqual({ x: 24, y: 24, w: 552, h: 452 })
})

test('C4: selecting a session pans only when it is outside the safe area, to the safe area’s centre, and never zooms', () => {
  const camera = { x: 0, y: 0, w: 1000, h: 600 }
  const safe = { x: 24, y: 24, w: 552, h: 452 }
  expect(focusPan(camera, STAGE, { x: 300, y: 300 }, safe)).toBe(camera)
  const moved = focusPan(camera, STAGE, { x: 900, y: 300 }, safe)
  expect(moved.w).toBe(1000)
  expect(moved.h).toBe(600)
  const k = STAGE.w / moved.w
  expect(near((900 - moved.x) * k, 24 + 552 / 2, 1e-5)).toBe(true)
  expect(near((300 - moved.y) * k, 24 + 452 / 2, 1e-5)).toBe(true)
})

test('C4: zoom stays between half the fitted scale and 4 px per unit, around the point zoomed at', () => {
  const fit = { x: 0, y: 0, w: 2000, h: 1200 }
  const limits = zoomLimits(fit, STAGE)
  expect(near(limits.min, 0.25, 1e-5)).toBe(true)
  expect(limits.max).toBe(4)
  const tooFar = clampZoom({ x: 0, y: 0, w: 10_000, h: 6000 }, STAGE, limits)
  expect(near(STAGE.w / tooFar.w, 0.25, 1e-5)).toBe(true)
  expect(near(tooFar.x + tooFar.w / 2, 5000, 1e-5)).toBe(true)
  const tooClose = clampZoom({ x: 100, y: 100, w: 100, h: 60 }, STAGE, limits)
  expect(near(STAGE.w / tooClose.w, 4, 1e-9)).toBe(true)
  const fine = { x: 0, y: 0, w: 1000, h: 600 }
  expect(clampZoom(fine, STAGE, limits)).toBe(fine)
})

test('C4: transitions ease out and land exactly on the target', () => {
  expect(easeOut(0)).toBe(0)
  expect(easeOut(1)).toBe(1)
  expect(easeOut(0.5)).toBeGreaterThan(0.5)
  const from = { x: 0, y: 0, w: 100, h: 60 }
  const to = { x: 100, y: 50, w: 200, h: 120 }
  expect(tweenCamera(from, to, 1)).toEqual(to)
  expect(tweenCamera(from, to, 0)).toEqual(from)
})

test('C4: the minimap shows the whole map and the camera as a rectangle inside it, and maps a click back to a world point', () => {
  const nodes = [{ x: 0, y: 0, r: 10 }, { x: 1000, y: 500, r: 10 }] as never
  const view = minimapView(nodes, { w: 160, h: 96 }, { x: 400, y: 200, w: 200, h: 120 })
  expect(view.rect.w).toBeGreaterThan(0)
  expect(view.rect.x).toBeGreaterThanOrEqual(0)
  expect(view.rect.x + view.rect.w).toBeLessThanOrEqual(160)
  const world = view.toWorld(view.rect.x + view.rect.w / 2, view.rect.y + view.rect.h / 2)
  expect(near(world.x, 500, 0.6)).toBe(true)
  expect(near(world.y, 260, 0.6)).toBe(true)
})

test('C4 review #2: zooming at a limit keeps the point under the pointer fixed (the factor is clamped, not the result)', () => {
  const limits = { min: 0.25, max: 4 }
  const atMax = { x: 100, y: 100, w: 250, h: 150 }
  const point = { x: 300, y: 200 }
  const next = zoomAround(atMax, STAGE, point, 0.5, limits)
  expect(next).toEqual(atMax)
  const near4 = { x: 100, y: 100, w: 300, h: 180 }
  const z = zoomAround(near4, STAGE, point, 0.5, limits)
  expect(near(STAGE.w / z.w, 4, 1e-9)).toBe(true)
  const before = (point.x - near4.x) / near4.w
  const after = (point.x - z.x) / z.w
  expect(near(before, after, 1e-9)).toBe(true)
})
