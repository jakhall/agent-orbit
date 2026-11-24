import { expect, test } from 'claude-code/testing'

import { failureText } from '../shared/failure.js'
import { statusOf } from '../shared/aggregate/status.js'
import { NOW, session } from './fixtures'

const observed = { source: 'mod-events' as const, confidence: 'observed' as const, observedAt: NOW - 60_000, detail: null }
const inferred = { ...observed, confidence: 'inferred' as const }

test('a pending Orbit approval or question puts the session in Needs you, from when it was asked (A4)', () => {
  const s = session('local_a', { lifecycle: 'running', stateSince: NOW - 600_000 })
  expect(statusOf(s, { approvals: [{ kind: 'permission', toolName: 'Bash', createdAt: NOW - 30_000 }] }, NOW)).toEqual({ bucket: 'needs-you', reason: 'Approve Bash?', since: NOW - 30_000, isObserved: true })
  expect(statusOf(s, { approvals: [{ kind: 'question', toolName: 'AskUserQuestion', createdAt: NOW - 5_000 }] }, NOW).reason).toBe('Asked you a question')
})

test('C7: more than one pending request reads as a count, from the oldest; one keeps its own wording', () => {
  const s = session('local_a', { lifecycle: 'running', stateSince: NOW - 600_000 })
  const permission = { kind: 'permission' as const, toolName: 'Bash', createdAt: NOW - 30_000 }
  const question = { kind: 'question' as const, toolName: 'AskUserQuestion', createdAt: NOW - 5_000 }
  for (const approvals of [[permission, question], [question, permission]]) {
    expect(statusOf(s, { approvals }, NOW)).toEqual({ bucket: 'needs-you', reason: '2 requests waiting', since: NOW - 30_000, isObserved: true })
  }
  expect(statusOf(s, { approvals: [permission, question, { ...question, createdAt: NOW - 1_000 }] }, NOW).reason).toBe('3 requests waiting')
  expect(statusOf(s, { approvals: [permission] }, NOW).reason).toBe('Approve Bash?')
})

test('waiting on the person is Needs you with the attention text, since the need began', () => {
  const s = session('local_a', { lifecycle: 'waiting-user', attention: 'question', attentionText: 'Asked you a question', attentionSince: NOW - 90_000, stateSince: NOW - 90_000, lifecycleEvidence: observed })
  expect(statusOf(s, {}, NOW)).toEqual({ bucket: 'needs-you', reason: 'Asked you a question', since: NOW - 90_000, isObserved: true })
  const blocked = session('local_b', { lifecycle: 'idle', attention: 'blocked', attentionText: 'Waiting for the API key', stateSince: NOW - 10_000, lifecycleEvidence: inferred })
  expect(statusOf(blocked, {}, NOW)).toMatchObject({ bucket: 'needs-you', reason: 'Waiting for the API key', isObserved: false })
})

test('a failed turn or a current desktop failure mark is Failed, worded by failureText (A4)', () => {
  const failed = session('local_a', { lifecycle: 'failed', attention: 'failed', attentionText: 'The model refused the last turn', stateSince: NOW - 20_000, lifecycleEvidence: observed })
  expect(statusOf(failed, {}, NOW)).toEqual({ bucket: 'failed', reason: 'The model refused the last turn', since: NOW - 20_000, isObserved: true })
  const crashed = session('local_b', { lifecycle: 'idle', stateSince: NOW - 600_000 })
  expect(statusOf(crashed, { failure: { category: 'disk_full', at: NOW - 40_000, source: 'error', isCurrent: true } }, NOW)).toEqual({ bucket: 'failed', reason: failureText('disk_full'), since: NOW - 40_000, isObserved: true })
  expect(statusOf(crashed, { failure: { category: 'disk_full', at: NOW - 900_000, source: 'error', isCurrent: false } }, NOW).bucket).toBe('idle')
})

test('running is Working with its activity; a silent open turn is Working, inferred, and says it may be stuck', () => {
  const running = session('local_a', { lifecycle: 'running', activity: 'Running tests', stateSince: NOW - 120_000, lifecycleEvidence: observed })
  expect(statusOf(running, {}, NOW)).toEqual({ bucket: 'working', reason: 'Running tests', since: NOW - 120_000, isObserved: true })
  const stale = session('local_b', { lifecycle: 'stale', stateSince: NOW - 12 * 60_000, lifecycleEvidence: inferred })
  expect(statusOf(stale, {}, NOW)).toEqual({ bucket: 'working', reason: 'No activity for 12m · may be stuck', since: NOW - 12 * 60_000, isObserved: false })
})

test('a turn that finished after the person last looked is Review, since it finished; terminal sessions without a focus time stay Idle', () => {
  const done = session('local_a', { lifecycle: 'idle', finishedAt: NOW - 300_000, stateSince: NOW - 300_000 })
  expect(statusOf(done, { lastFocusedAt: NOW - 900_000 }, NOW)).toMatchObject({ bucket: 'review', since: NOW - 300_000 })
  expect(statusOf(done, { lastFocusedAt: NOW - 60_000 }, NOW).bucket).toBe('idle')
  expect(statusOf(done, { lastFocusedAt: null }, NOW).bucket).toBe('idle')
})

test('everything else is Idle with a plain one-line reason', () => {
  expect(statusOf(session('local_a', { lifecycle: 'interrupted', stateSince: NOW - 5_000 }), {}, NOW)).toMatchObject({ bucket: 'idle', reason: 'Interrupted', since: NOW - 5_000 })
  expect(statusOf(session('local_b', { lifecycle: 'disconnected' }), {}, NOW)).toMatchObject({ bucket: 'idle', reason: 'Stopped reporting' })
  const noisy = statusOf(session('local_c', { lifecycle: 'running', activity: `Editing **app.ts**\nand ${'x'.repeat(300)}` }), {}, NOW)
  expect(noisy.reason.includes('\n')).toBe(false)
  expect(noisy.reason.length).toBeLessThanOrEqual(120)
})

test('failure categories read the same everywhere; unknown ones are named, never echoed raw', () => {
  expect(failureText('disk_full')).toBe('Claude could not start: disk full')
  expect(failureText('refusal')).toBe('The model refused the last turn')
  expect(failureText('weird category <b>!')).toBe('Failed (weird_category_b)')
})

test('after C9: a PR problem makes only a quiet session need you; running, waiting, failed and needing sessions keep their status', () => {
  const prProblem = { reason: 'PR checks failing: a/b#7', since: NOW - 120_000 }
  const quiet = session('local_a', { lifecycle: 'idle', stateSince: NOW - 600_000 })
  expect(statusOf(quiet, { prProblem }, NOW)).toEqual({ bucket: 'needs-you', reason: 'PR checks failing: a/b#7', since: NOW - 120_000, isObserved: true })
  expect(statusOf({ ...quiet, attention: 'review' }, { prProblem }, NOW).bucket).toBe('needs-you')
  expect(statusOf(session('local_r', { lifecycle: 'running', stateSince: NOW - 60_000 }), { prProblem }, NOW).bucket).toBe('working')
  expect(statusOf(session('local_w', { lifecycle: 'waiting-user', attention: 'question', attentionText: 'Asked you a question' }), { prProblem }, NOW).reason).toBe('Asked you a question')
  expect(statusOf(session('local_f', { lifecycle: 'failed' }), { prProblem }, NOW).bucket).toBe('failed')
  expect(statusOf(session('local_q', { lifecycle: 'waiting-user', attention: null }), { prProblem }, NOW).bucket).not.toBe('needs-you')
  expect(statusOf(quiet, { prProblem: null }, NOW).bucket).toBe('idle')
})
