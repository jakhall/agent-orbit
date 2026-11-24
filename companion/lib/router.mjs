import { createHmac } from 'node:crypto'

import { isNonce, NONCE_HEADER, PROOF_HEADER } from '../../shared/proof.js'
import { isActingRoute, isWindowAway } from './daemon.mjs'
import { send } from './http.mjs'
import { errorWhere } from './log.mjs'
import { opts, log } from './runtime.mjs'
import { cookieToken, isControlRoute, queryToken } from './secrets.mjs'
import { pageRoutes } from './routes/pages.mjs'
import { remoteRoutes } from './routes/remote.mjs'
import { sessionRoutes } from './routes/sessions.mjs'
import { windowRoutes } from './routes/window.mjs'

export function createRouter(c) {
  const { s, secrets, clients } = c
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${s.port}`)
      const host = req.headers.host ?? ''
      if (host !== `127.0.0.1:${s.port}` && host !== `localhost:${s.port}`) return send(res, 421, { error: 'wrong host' })
      const origin = req.headers.origin
      if (origin && origin !== `http://127.0.0.1:${s.port}` && origin !== `http://localhost:${s.port}`) {
        return send(res, 403, { error: 'cross-origin' })
      }
      const route = url.pathname
      if (await pageRoutes(c, req, res, url, route)) return

      const header = req.headers['x-orbit-token']
      const candidates = [typeof header === 'string' ? header : null, queryToken(url, route, opts.dryRun), cookieToken(req.headers.cookie)]
      const scope = candidates.map(given => secrets.scopeOf(given)).find(found => found !== null) ?? null
      if (scope === null || (scope === 'control' && !isControlRoute(req.method, route))) return send(res, 403, { error: 'bad token' })
      const nonce = req.headers[NONCE_HEADER]
      if (scope === 'control' && isNonce(nonce)) res.setHeader(PROOF_HEADER, createHmac('sha256', secrets.controlToken).update(nonce).digest('hex'))

      if (isActingRoute(req.method, route) && isWindowAway({ clients: clients.size, lastClientAt: s.lastClientAt, now: Date.now() })) return send(res, 409, { error: 'Open the Orbit window to act on sessions.', reason: 'no-window' })
      for (const routes of [windowRoutes, sessionRoutes, remoteRoutes]) if (await routes(c, req, res, url, route)) return
      return send(res, 404, { error: 'not found' })
    } catch (error) {
      const status = typeof error.status === 'number' ? error.status : 500
      log(`request ${req.method} ${(req.url ?? '').split('?')[0]} failed: ${status === 500 ? errorWhere(error) : error.message}`)
      if (status === 413 && !res.headersSent) {
        res.setHeader('connection', 'close')
        res.on('finish', () => req.destroy())
      }
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : error.message })
    }
  }
}
