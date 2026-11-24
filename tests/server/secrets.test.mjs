import assert from 'node:assert/strict'
import test from 'node:test'

import { COOKIE_NAME, LAUNCH_CODE_MS, PAGE_CSP, cookieToken, createSecrets, isControlRoute, queryToken } from '../../companion/lib/secrets.mjs'

test('two different secrets; the page one is never the control one (E-03)', () => {
  const s = createSecrets()
  assert.match(s.pageToken, /^[0-9a-f]{48}$/)
  assert.match(s.controlToken, /^[0-9a-f]{48}$/)
  assert.notEqual(s.pageToken, s.controlToken)
  assert.equal(s.scopeOf(s.pageToken), 'page')
  assert.equal(s.scopeOf(s.controlToken), 'control')
  assert.equal(s.scopeOf(`${s.pageToken}x`), null)
  assert.equal(s.scopeOf(undefined), null)
  assert.equal(s.scopeOf(['a']), null)
})

test('a launch code works once, within 60 s (E-16, E-50)', () => {
  const s = createSecrets()
  const code = s.issueLaunchCode(1_000)
  assert.match(code, /^[0-9a-f]{32}$/)
  assert.equal(s.redeemLaunchCode('nope', 1_000), false)
  assert.equal(s.redeemLaunchCode(code, 1_000 + LAUNCH_CODE_MS + 1), false, 'expired')
  const fresh = s.issueLaunchCode(5_000)
  assert.equal(s.redeemLaunchCode(fresh, 5_100), true)
  assert.equal(s.redeemLaunchCode(fresh, 5_200), false, 'single use')
})

test('the cookie is read by name only; the control token reaches the control routes only (E-03)', () => {
  assert.equal(cookieToken(`a=1; ${COOKIE_NAME}=abc; b=2`), 'abc')
  assert.equal(cookieToken('x=1'), null)
  assert.equal(cookieToken(undefined), null)
  for (const [method, route] of [['GET', '/api/ping'], ['POST', '/api/window'], ['POST', '/api/shutdown'], ['POST', '/api/hook/requests'], ['GET', '/api/hook/requests/abc'], ['GET', '/api/mod/replies/abc'], ['GET', '/api/arm']]) assert.equal(isControlRoute(method, route), true, route)
  for (const [method, route] of [['GET', '/api/state'], ['GET', '/api/conversation'], ['POST', '/api/reply'], ['POST', '/api/arm'], ['GET', '/api/health'], ['POST', '/api/approvals/x']]) assert.equal(isControlRoute(method, route), false, route)
})

test('a launch code redeemed a second time says so, and rotating the page secret revokes the old cookie (review: argv leak)', () => {
  const s = createSecrets()
  const code = s.issueLaunchCode(1_000)
  assert.equal(s.redeemLaunchCode(code, 1_100), true)
  assert.equal(s.wasUsed(code), true, 'someone redeemed this code before the window did')
  assert.equal(s.wasUsed('never-issued'), false)
  const old = s.pageToken
  s.rotatePage()
  assert.notEqual(s.pageToken, old)
  assert.equal(s.scopeOf(old), null, 'the old cookie no longer works')
  assert.equal(s.scopeOf(s.pageToken), 'page')
})

test('security read S3: a page secret in the query is read only by a dry-run server, and only on the entry pages and the event stream', () => {
  const url = route => new URL(`http://127.0.0.1${route}?t=abc`)
  for (const route of ['/inbox', '/api/events']) {
    assert.equal(queryToken(url(route), route, true), 'abc', route)
    assert.equal(queryToken(url(route), route, false), null, route)
  }
  for (const route of ['/', '/api/state']) assert.equal(queryToken(url(route), route, true), null, `${route} (/ only redirects to /inbox since C9)`)
})

test('security read S4: the page CSP allows scripts from Orbit only and pins base and form targets', () => {
  for (const part of ["default-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "connect-src 'self'"]) assert.ok(PAGE_CSP.includes(part), part)
  assert.doesNotMatch(PAGE_CSP, /script-src[^;]*unsafe/)
})
