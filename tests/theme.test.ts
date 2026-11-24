import { expect, test } from 'claude-code/testing'

import { PALETTE, PALETTE_LIGHT } from '../shared/constants.js'
import { BUCKET_COLOR_KEY } from '../shared/map.js'

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

test('C8: both palettes keep labels at 4.5:1 and dots and meaningful marks at 3:1 on every surface', () => {
  type Role = keyof typeof PALETTE
  const grounds: Role[] = ['bg', 'surface', 'raised']
  const marks = [...Object.values(BUCKET_COLOR_KEY), 'accent', 'muted'] as Role[]
  for (const P of [PALETTE, PALETTE_LIGHT] as Record<Role, string>[]) {
    for (const ground of grounds) {
      for (const label of ['text', 'muted', 'accent'] as Role[]) expect(contrast(P[label], P[ground])).toBeGreaterThanOrEqual(4.5)
      for (const mark of marks) expect(contrast(P[mark], P[ground])).toBeGreaterThanOrEqual(3)
      expect(contrast(P.controlEdge, P[ground])).toBeGreaterThanOrEqual(3)
    }
    expect(contrast(P.onAccent, P.accent)).toBeGreaterThanOrEqual(4.5)
  }
})

test("2.1: 1.15's palette keys are back with a light twin each, and pass contrast where 1.15 used them", () => {
  const P = PALETTE as Record<string, string>
  const L = PALETTE_LIGHT as Record<string, string>
  const pair = (T: Record<string, string>, a: string, b: string) => contrast(T[a] ?? '#000000', T[b] ?? '#000000')
  expect(P.bg).toBe('#0B0C0E')
  expect(P.text).toBe('#E4E6EA')
  expect(P.muted).toBe('#8B9099')
  expect(P.lineStrong).toBe('#3C4048')
  expect([P.bg2, P.bg3, P.label, P.faint, P.grey, P.hover]).toEqual(['#141518', '#1B1D21', '#C3C7CE', '#7C818A', '#80858E', '#22252A'])
  expect(Object.keys(L).sort()).toEqual(Object.keys(P).sort())
  for (const T of [P, L]) {
    for (const ground of ['bg', 'surface', 'raised', 'bg2', 'bg3', 'hover']) {
      expect(pair(T, 'label', ground)).toBeGreaterThanOrEqual(4.5)
      expect(pair(T, 'text', ground)).toBeGreaterThanOrEqual(4.5)
      expect(pair(T, 'grey', ground)).toBeGreaterThanOrEqual(3)
    }
    for (const ground of ['bg', 'surface', 'bg2']) expect(pair(T, 'faint', ground)).toBeGreaterThanOrEqual(4.5)
  }
})
