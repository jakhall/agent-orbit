import fs from 'node:fs'
import path from 'node:path'

import { PALETTE } from '../../../shared/constants.js'
import { send } from '../http.mjs'
import { HERE, ROOT, opts } from '../runtime.mjs'
import { COOKIE_NAME, cookieToken, queryToken } from '../secrets.mjs'

const SHARED_FILES = new Set(['approvals.js', 'camera.js', 'constants.js', 'failure.js', 'filters.js', 'format.js', 'inbox.js', 'launch.js', 'layout.js', 'links.js', 'map.js', 'markdown.js', 'popout.js', 'prefs.js', 'pr-links.js', 'render.js', 'skills.js'])
const ENTRY_PAGES = { '/inbox': 'inbox.html' }
const INBOX_FILE = /^[a-z0-9-]+\.(?:js|css)$/
const ICON_FILES = {
  '/icons/orbit.svg': ['orbit.svg', 'image/svg+xml'],
  '/icons/orbit-16.png': ['orbit-16.png', 'image/png'],
  '/icons/orbit-24.png': ['orbit-24.png', 'image/png'],
  '/icons/orbit-32.png': ['orbit-32.png', 'image/png'],
  '/icons/orbit-48.png': ['orbit-48.png', 'image/png'],
  '/icons/orbit-256.png': ['orbit-256.png', 'image/png'],
  '/favicon.ico': ['favicon.ico', 'image/x-icon'],
}
const paletteCss = `<style>:root{${Object.entries(PALETTE)
  .map(([name, value]) => `--${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}:${value}`)
  .join(';')}}</style>`

export async function pageRoutes(c, req, res, url, route) {
  const { secrets, raiseAlert, clients, heartbeat } = c
  const pageCookie = () => `${COOKIE_NAME}=${secrets.pageToken}; HttpOnly; SameSite=Strict; Path=/`
  const isPageSecret = given => secrets.scopeOf(given) === 'page'
  if (req.method === 'GET' && route === '/') {
    res.writeHead(303, { location: `/inbox${url.search}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    return res.end()
  }
  if (req.method === 'GET' && ENTRY_PAGES[route]) {
    const launchCode = url.searchParams.get('launch')
    if (launchCode !== null) {
      if (!secrets.redeemLaunchCode(launchCode, Date.now())) {
        if (secrets.wasUsed(launchCode)) {
          secrets.rotatePage()
          heartbeat()
          for (const stream of clients) stream.end()
          raiseAlert('window', 'link-reused')
          return send(res, 403, 'Something else opened this window link first. Orbit changed the window key, so whatever took it is locked out. Open the dashboard again from the Orbit pane (Pop out).', 'text/plain; charset=utf-8')
        }
        return send(res, 403, 'This window link has expired. Open the dashboard from the Orbit pane (Pop out).', 'text/plain; charset=utf-8')
      }
      res.writeHead(303, { location: route, 'set-cookie': pageCookie(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      return res.end()
    }
    const isTestLink = isPageSecret(queryToken(url, route, opts.dryRun))
    if (!isTestLink && !isPageSecret(cookieToken(req.headers.cookie))) return send(res, 403, 'Open the dashboard from the Orbit pane (Pop out).', 'text/plain; charset=utf-8')
    if (isTestLink) res.setHeader('set-cookie', pageCookie())
    const html = fs.readFileSync(path.join(HERE, ENTRY_PAGES[route]), 'utf8').replace('</head>', `${paletteCss}</head>`)
    return send(res, 200, html, 'text/html; charset=utf-8')
  }
  if (req.method === 'GET' && route.startsWith('/inbox/')) {
    const name = route.slice('/inbox/'.length)
    const file = INBOX_FILE.test(name) ? path.join(HERE, 'inbox', name) : null
    if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return send(res, 404, { error: 'not found' })
    return send(res, 200, fs.readFileSync(file), name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8')
  }
  if (req.method === 'GET' && route.startsWith('/shared/')) {
    const name = route.slice('/shared/'.length)
    if (!SHARED_FILES.has(name)) return send(res, 404, { error: 'not found' })
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'shared', name)), 'text/javascript; charset=utf-8')
  }
  if (req.method === 'GET' && Object.hasOwn(ICON_FILES, route)) {
    const [file, type] = ICON_FILES[route]
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(type === 'image/svg+xml' ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } : {}),
    })
    return res.end(fs.readFileSync(path.join(HERE, 'icons', file)))
  }
  if (req.method === 'GET' && route.startsWith('/icons/')) return send(res, 404, { error: 'not found' })
}
