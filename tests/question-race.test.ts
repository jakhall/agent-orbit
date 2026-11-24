import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { inbox } from '../src/core/inbox'
import { askBoth, dismissedText, isQuestionResult, questionInput } from '../src/core/questions'
import type { Paths } from '../src/paths'
import { proofOf } from '../shared/proof.js'

const COMPANION = 'C:\\data\\companion.json'
const ID = '0a1b2c3d-0000-4000-8000-0000000000f1'
const NONCE = '0a1b2c3d-0000-4000-8000-0000000000f2'
const question = { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] }
const answered = { ...question, answers: { 'Which?': 'B' } }

type Call = { method: string; route: string; body: unknown }
type Polls = Array<() => Promise<{ status: number; value: unknown }>>

function fakeHost(options: { held?: unknown; polls?: Polls; hasServer?: boolean; proof?: 'wrong' } = {}) {
  const calls: Call[] = []
  const polls = [...(options.polls ?? [])]
  const $ = {
    fs: {
      read: async (path: string) => {
        if (path === COMPANION && options.hasServer !== false) return JSON.stringify({ port: 47999, token: 'control' })
        throw new Error('ENOENT')
      },
    },
    http: {
      fetch: async (url: string, init: { method: string; body?: string; headers?: Record<string, string> }) => {
        const route = url.replace('http://127.0.0.1:47999', '')
        calls.push({ method: init.method, route, body: init.body ? JSON.parse(init.body) : null })
        const proof = await proofOf(options.proof === 'wrong' ? 'not-the-token' : 'control', init.headers?.['x-orbit-nonce'] ?? '')
        const reply = (status: number, value: unknown) => ({ status, ok: status === 200, headers: { 'x-orbit-proof': proof }, text: JSON.stringify(value) })
        if (route === '/api/mod/questions') return reply(200, options.held ?? { engaged: true, id: ID, nonce: NONCE })
        if (route.startsWith(`/api/hook/requests/${ID}?`)) {
          const next = polls.shift()
          if (!next) return new Promise(() => undefined)
          const got = await next()
          return reply(got.status, got.value)
        }
        return reply(200, { ok: true })
      },
    },
    ui: { log: () => undefined },
  } as unknown as EngineInterface
  return { $, calls }
}

function session(me = 'cli-1') {
  inbox.me = me
  inbox.paths = { companion: COMPANION } as Paths
}

const event = { tool: 'AskUserQuestion', tool_use_id: 'tu-1', agentId: 'agent-7', consent: {}, ...question }
const never = <T>() => new Promise<T>(() => undefined)
const later = async <T>(value: T, ticks = 5): Promise<T> => {
  for (let i = 0; i < ticks * 10; i += 1) await Promise.resolve()
  return value
}

test('2.1.6 race: the question sent to Orbit is the tool input without the engine keys, with the agent', async () => {
  session()
  const { $, calls } = fakeHost({ polls: [async () => ({ status: 200, value: { status: 'answered', result: answered } })] })
  await askBoth($, event, never)
  expect(questionInput(event)).toEqual(question)
  expect(calls[0]).toEqual({ method: 'POST', route: '/api/mod/questions', body: { cliSessionId: 'cli-1', toolInput: question, agentId: 'agent-7' } })
  expect(calls[1]?.route).toBe(`/api/hook/requests/${ID}?nonce=${NONCE}&waitMs=5000`)
})

test('2.1.6 race: an Orbit answer settles the call as the tool result while Claude still waits', async () => {
  session()
  const { $ } = fakeHost({ polls: [async () => ({ status: 200, value: { status: 'pending' } }), async () => ({ status: 200, value: { status: 'answered', result: answered } })] })
  expect(await askBoth($, event, never)).toEqual({ result: answered })
})

test('2.1.6 race: a Claude answer wins and ends the held copy as answered in Claude', async () => {
  session()
  const { $, calls } = fakeHost()
  const claude = { result: { ...question, answers: { 'Which?': 'A' } } }
  expect(await askBoth($, event, () => later(claude))).toEqual(claude)
  expect(calls.at(-1)).toEqual({ method: 'POST', route: `/api/hook/requests/${ID}/end`, body: { nonce: NONCE, outcome: 'answered in Claude' } })
})

test('2.1.6 race: an ask from Orbit, a broken result or a gone request leaves the answer to Claude', async () => {
  for (const value of [{ status: 'answered', result: null }, { status: 'answered', result: { answers: { 'Which?': 3 } } }]) {
    session()
    const { $ } = fakeHost({ polls: [async () => ({ status: 200, value })] })
    const claude = { result: { from: 'claude' } }
    expect(await askBoth($, event, () => later(claude, 20))).toEqual(claude)
  }
  session()
  const { $ } = fakeHost({ polls: [async () => ({ status: 410, value: { status: 'gone' } })] })
  expect(await askBoth($, event, () => later({ result: 'c' }, 20))).toEqual({ result: 'c' })
})

test('2.1.6 race: an Orbit answer without the proof for its nonce is ignored and Claude answers', async () => {
  session()
  const { $ } = fakeHost({ proof: 'wrong', polls: [async () => ({ status: 200, value: { status: 'answered', result: answered } })] })
  const claude = { result: { from: 'claude' } }
  expect(await askBoth($, event, () => later(claude, 20))).toEqual(claude)
})

test('2.1.6 race: no server, no session, or not engaged means only Claude asks, with no polling', async () => {
  const claude = { result: 'only-claude' }
  for (const setup of [{ hasServer: false }, { held: { engaged: false } }, { held: { engaged: true, id: ID } }]) {
    session()
    const { $, calls } = fakeHost(setup)
    expect(await askBoth($, event, () => later(claude))).toEqual(claude)
    expect(calls.some(c => c.route.startsWith('/api/hook/requests/'))).toBe(false)
  }
  session('')
  const { $, calls } = fakeHost()
  expect(await askBoth($, event, () => later(claude))).toEqual(claude)
  expect(calls).toEqual([])
})

test('2.1.6 race: when Claude throws, the held copy is ended and the error passes on', async () => {
  session()
  const { $, calls } = fakeHost()
  let error: unknown = null
  await askBoth($, event, () => later(null, 5).then(() => Promise.reject(new Error('boom')))).catch(e => (error = e))
  expect(String(error)).toContain('boom')
  expect(calls.at(-1)?.body).toEqual({ nonce: NONCE, outcome: 'stopped' })
})

test('2.1.6 race: a message from Orbit dismisses the question: the model reads it as the refusal', async () => {
  session()
  const { $ } = fakeHost({ polls: [async () => ({ status: 200, value: { status: 'dismissed', message: 'Do X instead.' } })] })
  expect(await askBoth($, event, never)).toEqual({ deny: dismissedText('Do X instead.') })
  expect(dismissedText('Do X instead.')).toContain('Do X instead.')
})

test('2.1.6 race: a dismiss without text leaves the answer to Claude', async () => {
  session()
  const { $ } = fakeHost({ polls: [async () => ({ status: 200, value: { status: 'dismissed', message: '  ' } })] })
  expect(await askBoth($, event, () => later({ result: 'c' }, 20))).toEqual({ result: 'c' })
})

test('2.1.6 race: isQuestionResult wants an object of text answers', () => {
  expect(isQuestionResult(answered)).toBe(true)
  expect([null, [], {}, { answers: [] }, { answers: { q: 1 } }].map(isQuestionResult)).toEqual([false, false, false, false, false])
})
