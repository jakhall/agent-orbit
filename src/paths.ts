import type { EngineInterface } from 'claude-code'

import { joinWith } from '../shared/aggregate/path-utils.js'

export { basename, errorText, joinWith, normalizePath, readJson } from '../shared/aggregate/path-utils.js'

export type Paths = {
  sep: string
  data: string
  sessionsDir: string
  /** `inbox/<cliSessionId>/`: reply requests from the pop-out server for that session's own mod. */
  inboxDir: string
  /** The server's schema 2 snapshot (`snapshot-v2.json`), which panes read. */
  snapshotV2: string
  prefs: string
  companion: string
  desktopRoot: string | null
  projectsDir: string
  pluginRoot: string
  /** `%SystemRoot%\System32`: system tools run from here by full path, never found through the session's folder. */
  system32: string
}

const DATA_FOLDER = 'orbit'


export async function resolvePaths($: EngineInterface): Promise<Paths> {
  const userProfile = await $.env.get('USERPROFILE')
  const homeVar = await $.env.get('HOME')
  const appData = await $.env.get('APPDATA')
  const systemRoot = (await $.env.get('SystemRoot')) ?? (await $.env.get('SYSTEMROOT')) ?? 'C:\\Windows'
  const home = userProfile ?? homeVar ?? ''
  const sep = home.includes('\\') || appData !== undefined ? '\\' : '/'
  const dataOverride = (await $.env.get('ORBIT_DATA_DIR'))?.replace(/[\\/]+$/, '') ?? ''
  const isLocalAbsolute = /^[A-Za-z]:[\\/][^\\/]/.test(dataOverride)
  const data = isLocalAbsolute ? dataOverride : joinWith(sep, home, '.claude', DATA_FOLDER)
  return {
    sep,
    data,
    sessionsDir: joinWith(sep, data, 'sessions'),
    inboxDir: joinWith(sep, data, 'inbox'),
    snapshotV2: joinWith(sep, data, 'snapshot-v2.json'),
    prefs: joinWith(sep, data, 'prefs.json'),
    companion: joinWith(sep, data, 'companion.json'),
    desktopRoot: appData ? joinWith(sep, appData, 'Claude', 'claude-code-sessions') : null,
    projectsDir: joinWith(sep, home, '.claude', 'projects'),
    pluginRoot: $.plugin.root,
    system32: joinWith('\\', systemRoot, 'System32'),
  }
}
