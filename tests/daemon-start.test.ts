import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { createDaemonStarter, DAEMON_RETRY_MS, ensureDaemon, readArmed } from '../src/companion'
import type { Paths } from '../src/paths'
import { proofOf } from '../shared/proof.js'

const NOW = 1_800_000_000_000
const MOD = '1.16.0'
const paths = {
  sep: '\\',
  data: 'C:\\orbit-data',
  companion: 'C:\\orbit-data\\companion.json',
  pluginRoot: 'C:\\mods\\orbit',
  system32: 'C:\\Windows\\System32',
} as unknown as Paths

type Answer = { exitCode: number; stdout: string; stderr?: string }

function engine(options: { companion?: { version?: string; ageMs: number }; onDisk?: Answer; launch?: Answer }) {
  const runs: string[][] = []
  const $ = {
    fs: {
      read: async (path: string) => {
        if (path !== paths.companion || !options.companion) throw new Error('ENOENT')
        return JSON.stringify({ port: 5000, pid: 42, token: 't', version: options.companion.version, clients: 0, lastSeenAt: 0 })
      },
      stat: async (path: string) => {
        if (path !== paths.companion || !options.companion) throw new Error('ENOENT')
        return { kind: 'file', size: 10, mtimeMs: NOW - options.companion.ageMs, isLink: false }
      },
    },
    process: {
      run: async (argv: string[]) => {
        if (argv[0]?.endsWith('where.exe')) return { exitCode: 0, stdout: 'C:\\node\\node.exe\r\n', stderr: '' }
        runs.push(argv.slice(2))
        if (argv.includes('--version')) return { stderr: '', ...(options.onDisk ?? { exitCode: 0, stdout: JSON.stringify({ ok: true, version: MOD }) }) }
        return { stderr: '', ...(options.launch ?? { exitCode: 0, stdout: JSON.stringify({ ok: true, message: 'The Orbit server started.' }) }) }
      },
    },
  } as unknown as EngineInterface
  return { $, runs }
}

test('no live server: the mod checks the on-disk version, then starts a daemon with no window (daemon)', async () => {
  const { $, runs } = engine({})
  const starter = createDaemonStarter()
  expect(await ensureDaemon($, paths, NOW, starter, MOD)).toBe('started')
  expect(runs).toEqual([
    ['--version'],
    ['--launch', '--no-window', '--data', 'C:\\orbit-data'],
  ])
  expect(starter.note).toBe(null)
})

test('a live server of this version or newer is left alone (daemon)', async () => {
  for (const version of [MOD, '1.17.0']) {
    const { $, runs } = engine({ companion: { version, ageMs: 5_000 } })
    expect(await ensureDaemon($, paths, NOW, createDaemonStarter(), MOD)).toBe('live')
    expect(runs).toEqual([])
  }
})

test('a live older server or a stale record leads to a start, which replaces the older one (daemon)', async () => {
  for (const companion of [{ version: '1.15.2', ageMs: 5_000 }, { version: MOD, ageMs: 120_000 }]) {
    const { $, runs } = engine({ companion })
    expect(await ensureDaemon($, paths, NOW, createDaemonStarter(), MOD)).toBe('started')
    expect(runs.at(-1)?.slice(0, 2)).toEqual(['--launch', '--no-window'])
  }
})

test('an older server on disk (a rollback) is never started; the pane says why (daemon)', async () => {
  const answers: Answer[] = [
    { exitCode: 2, stdout: JSON.stringify({ ok: false, message: 'usage: server.mjs --launch|--serve|--prune|--clear --data <dir>' }) },
    { exitCode: 0, stdout: JSON.stringify({ ok: true, version: '1.15.2' }) },
    { exitCode: 0, stdout: 'not json' },
  ]
  for (const onDisk of answers) {
    const { $, runs } = engine({ onDisk })
    const starter = createDaemonStarter()
    expect(await ensureDaemon($, paths, NOW, starter, MOD)).toBe('older-on-disk')
    expect(runs).toEqual([['--version']])
    expect(starter.note ?? '').toContain('older')
  }
})

test('the mod tries at most once a minute (daemon)', async () => {
  const { $, runs } = engine({ launch: { exitCode: 1, stdout: JSON.stringify({ ok: false, message: 'The dashboard server did not start' }) } })
  const starter = createDaemonStarter()
  expect(await ensureDaemon($, paths, NOW, starter, MOD)).toBe('failed')
  expect(starter.note ?? '').toContain('did not start')
  expect(await ensureDaemon($, paths, NOW + DAEMON_RETRY_MS - 1, starter, MOD)).toBe('waiting')
  expect(runs.length).toBe(2)
  expect(await ensureDaemon($, paths, NOW + DAEMON_RETRY_MS, starter, MOD)).toBe('failed')
  expect(runs.length).toBe(4)
})

test('the pane learns which capabilities are armed from the server, for its indicator (D-6)', async () => {
  const calls: { url: string; token: string | undefined }[] = []
  const fake = {
    fs: {
      read: async () => JSON.stringify({ port: 5000, token: 'control', pid: 1 }),
      stat: async () => ({ kind: 'file', size: 10, mtimeMs: NOW, isLink: false }),
    },
    http: {
      fetch: async (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url, token: init?.headers?.['x-orbit-token'] })
        const proof = await proofOf(proofToken, init?.headers?.['x-orbit-nonce'] ?? '')
        return { status: 200, ok: true, headers: proofToken ? { 'x-orbit-proof': proof } : {}, text: JSON.stringify({ approvals: { armed: true }, questions: { armed: false }, replies: { armed: true }, tampered: false }) }
      },
    },
  } as unknown as EngineInterface
  let proofToken = 'control'
  expect(await readArmed(fake, paths)).toEqual(['approvals', 'replies'])
  expect(calls).toEqual([{ url: 'http://127.0.0.1:5000/api/arm', token: 'control' }])
  proofToken = 'not-the-token'
  expect(await readArmed(fake, paths)).toBe(null)
  proofToken = ''
  expect(await readArmed(fake, paths)).toBe(null)
  const down = { ...fake, http: { fetch: async () => Promise.reject(new Error('refused')) } } as unknown as EngineInterface
  expect(await readArmed(down, paths)).toBe(null)
})
