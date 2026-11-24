import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { DEFAULT_FILTERS, DEFAULT_SETTINGS } from '../shared/constants.js'
import { visibleOf } from '../shared/filters.js'
import { checkLaunch, LAUNCH_MODELS, launchModels } from '../shared/launch.js'
import { isPrUrl } from '../shared/prs.js'
import { resolvePaths } from '../src/paths'
import { normalizeDesktop } from '../shared/aggregate/desktop.js'
import { buildSnapshot, NOW, session } from './fixtures'

const DIGEST = 'a'.repeat(64)
const launchBody = { folder: 'C:\\repos\\app', prompt: '', model: 'claude-sonnet-5-6', effort: '', mode: 'manual', digest: DIGEST }

test('the launch list offers the current Fable and any well-formed model a recent session used, and nothing else (E-24)', () => {
  const values = LAUNCH_MODELS.map(o => o.value)
  expect(values).toContain('claude-fable-5-2')
  expect(values).not.toContain('claude-fable-5-1')
  const offered = launchModels(['claude-sonnet-5-6', 'claude-opus-5-5', 'claude-x --dangerously-skip-permissions', '../evil', 'claude-opus-5-5[1m]', 'gpt-5', null, 42])
  expect(offered.map(o => o.value)).toEqual([...values, 'claude-sonnet-5-6'])
  expect(checkLaunch(launchBody).ok).toBe(false)
  expect(checkLaunch(launchBody, offered).ok).toBe(true)
  expect(checkLaunch({ ...launchBody, model: 'claude-x --rm' }, offered).ok).toBe(false)
})

test('a PR link is shown or checked only when it is a plain GitHub pull request URL (E-45)', () => {
  for (const bad of ['https://github.com/a/../pull/1', 'https://github.com/./b/pull/1', 'https://github.com/../../pull/1']) expect(isPrUrl(bad)).toBe(false)
  const desktop = normalizeDesktop(
    { sessionId: 'local_1', prs: [{ url: 'https://evil.example/a/b/pull/1', prNumber: 1 }, { url: 'https://github.com/acme/app/pull/2', prNumber: 2 }] } as never,
    NOW,
    new Set(),
  )
  expect(desktop?.prs.map(p => p.url)).toEqual(['https://github.com/acme/app/pull/2'])
})

test('a project called __proto__ is counted like any other and leaves Object.prototype alone (E-44)', () => {
  const snap = buildSnapshot([session('local_a', { projectId: '__proto__', lifecycle: 'running', lastActivityAt: NOW })])
  const view = visibleOf(snap, DEFAULT_FILTERS, DEFAULT_SETTINGS, [], NOW)
  expect(view.projectCounts['__proto__']?.sessions).toBe(1)
  expect(({} as Record<string, unknown>).sessions).toBe(undefined)
})

test('the data-folder override is honoured only as an absolute local path (E-42)', async () => {
  const pathsWith = (override: string | undefined) => {
    const env: Record<string, string | undefined> = { USERPROFILE: 'C:\\Users\\t', APPDATA: 'C:\\Users\\t\\AppData\\Roaming', ORBIT_DATA_DIR: override }
    return resolvePaths({ env: { get: async (name: string) => env[name] }, plugin: { root: 'C:\\mods\\orbit' } } as unknown as EngineInterface)
  }
  expect((await pathsWith('C:\\scratch\\orbit\\')).data).toBe('C:\\scratch\\orbit')
  for (const refused of ['\\\\host\\share\\orbit', '//host/share/orbit', 'relative\\orbit', 'C:', '']) {
    expect((await pathsWith(refused)).data).toBe('C:\\Users\\t\\.claude\\orbit')
  }
})
