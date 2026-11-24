import path from 'node:path'

import { LAUNCH_EFFORTS, LAUNCH_MODES, launchModels } from '../../../shared/launch.js'
import { browserUrl, checkNewSession, isDesktopSessionId, openSessionLink } from '../../../shared/links.js'
import { gitRuns, changes } from '../git-changes.mjs'
import { send, readBody } from '../http.mjs'
import { dryRunBrowser, dryRunLaunches, launchLink, openInBrowser, NO_HANDLER, launches, checkFolder, launchSession, seenModels, launchState } from '../launches.mjs'
import { PR_WANT_MS, prs, prAnswer } from '../pr-checks.mjs'
import { opts, log, isFolder } from '../runtime.mjs'
import { suggestion } from '../suggestion.mjs'
import { AGENT_ID, conversation, conversationCursor } from '../transcripts.mjs'

const OPEN_AGAIN_MS = 2_000
let lastOpen = { link: '', at: 0 }
export async function sessionRoutes(c, req, res, url, route) {
  const { s, tickPrs } = c
  if (req.method === 'POST' && route === '/api/open') {
    const body = await readBody(req)
    if (typeof body.localId !== 'string' || !isDesktopSessionId(body.localId)) return send(res, 400, { error: 'not a desktop session id' })
    const link = openSessionLink(body.localId)
    if (link === lastOpen.link && Date.now() - lastOpen.at < OPEN_AGAIN_MS) return send(res, 200, { ok: true, dryRun: opts.dryRun })
    lastOpen = { link, at: Date.now() }
    try {
      await launchLink(link)
    } catch (error) {
      lastOpen = { link: '', at: 0 }
      log(`open session failed: ${error.message}${error.code === NO_HANDLER ? ' (handed to the window)' : ''}`)
      return send(res, 502, error.code === NO_HANDLER ? { error: error.message, handOff: link } : { error: error.message })
    }
    log(`open session ${body.localId}${opts.dryRun ? ' (dry run)' : ''}`)
    return send(res, 200, { ok: true, dryRun: opts.dryRun })
  }
  if (req.method === 'POST' && route === '/api/open-url') {
    const body = await readBody(req)
    const href = browserUrl(body.url)
    if (!href) return send(res, 400, { error: 'only an http or https address opens in the browser' })
    try {
      await openInBrowser(href)
    } catch (error) {
      log(`open in browser failed: ${error.message}`)
      return send(res, 502, { error: error.message })
    }
    log(`opened a link in the default browser${opts.dryRun ? ' (dry run)' : ''}`)
    return send(res, 200, { ok: true, dryRun: opts.dryRun })
  }
  if (req.method === 'POST' && route === '/api/new') {
    const body = await readBody(req)
    const checked = checkNewSession(body.folder, body.prompt)
    if (!checked.ok) return send(res, 400, { error: checked.error })
    if (!(await isFolder(checked.folder))) return send(res, 400, { error: `No folder at ${checked.folder}.` })
    try {
      await launchLink(checked.link)
    } catch (error) {
      log(`new session launch failed: ${error.message}${error.code === NO_HANDLER ? ' (handed to the window)' : ''}`)
      return send(res, 502, error.code === NO_HANDLER ? { error: error.message, handOff: checked.link } : { error: error.message })
    }
    log(`new session page opened for ${path.basename(checked.folder)}${opts.dryRun ? ' (dry run)' : ''}`)
    return send(res, 200, { ok: true, dryRun: opts.dryRun })
  }
  if (req.method === 'GET' && route === '/api/conversation') {
    const key = url.searchParams.get('key') ?? ''
    if (key === '' || key.length > 600) return send(res, 400, { error: 'a session key is needed' })
    const agent = url.searchParams.get('agent')
    if (agent !== null && !AGENT_ID.test(agent)) return send(res, 400, { error: 'not a sub-agent id' })
    const cursor = conversationCursor(url.searchParams)
    if (!cursor.ok) return send(res, 400, { error: 'before or from needs a byte offset and the transcript id' })
    const result = await conversation(key, cursor.cursor, url.searchParams.get('retry') === '1', agent)
    return send(res, result.status, result.body)
  }
  if (req.method === 'GET' && route === '/api/suggestion') {
    const key = url.searchParams.get('key') ?? ''
    if (key === '' || key.length > 600) return send(res, 400, { error: 'a session key is needed' })
    const result = await suggestion(key)
    return send(res, result.status, result.body)
  }
  if (req.method === 'GET' && route === '/api/changes') {
    const key = url.searchParams.get('key') ?? ''
    if (key === '' || key.length > 600) return send(res, 400, { error: 'a session key is needed' })
    const result = await changes(key, url.searchParams.get('fresh') === '1')
    return send(res, result.status, result.body)
  }
  if (req.method === 'GET' && route === '/api/folder') {
    const result = await checkFolder(url.searchParams.get('path') ?? '')
    return send(res, result.status, result.body)
  }
  if (req.method === 'GET' && route === '/api/launch/options') {
    return send(res, 200, { models: launchModels(await seenModels()), efforts: LAUNCH_EFFORTS, modes: LAUNCH_MODES })
  }
  const launchRoute = /^\/api\/launch\/([0-9a-f-]{36})$/.exec(route)
  if (launchRoute && req.method === 'GET') {
    const result = launchState(launchRoute[1])
    return send(res, result.status, result.body)
  }
  if (req.method === 'POST' && route === '/api/launch') {
    const result = await launchSession(await readBody(req))
    return send(res, result.status, result.body)
  }
  if (req.method === 'GET' && route === '/api/prs') {
    if (url.searchParams.get('want') === '1') {
      s.prsWantedUntil = Date.now() + PR_WANT_MS
      void tickPrs()
    }
    return send(res, 200, prAnswer())
  }
  if (req.method === 'GET' && route === '/api/dry-run' && opts.dryRun) return send(res, 200, { envNames: Object.keys(process.env).sort(), launches: dryRunLaunches, browser: dryRunBrowser, gh: prs.calls, spawns: launches.spawns, firstPrompts: launches.prompts.size, gitRuns })
}
