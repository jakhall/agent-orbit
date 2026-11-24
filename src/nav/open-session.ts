import type { EngineInterface } from 'claude-code'

import { checkNewSession, isDesktopSessionId, openSessionLink } from '../../shared/links.js'
import { joinWith, type Paths } from '../paths'

let claudeExe: Promise<string | undefined> | undefined

function findClaudeExe($: EngineInterface, paths: Paths): Promise<string | undefined> {
  claudeExe ??= $.process
    .run([joinWith('\\', paths.system32, 'reg.exe'), 'query', 'HKCU\\Software\\Classes\\claude\\shell\\open\\command', '/ve'], { cwd: paths.system32 })
    .then(({ stdout }) => stdout.match(/"([^"]+\\Claude\.exe)"/i)?.[1])
    .catch(() => undefined)
  return claudeExe
}

async function launchLink($: EngineInterface, paths: Paths, url: string): Promise<void> {
  const exe = await findClaudeExe($, paths)
  if (!exe) throw new Error("Claude desktop's claude:// link handler is not registered on this machine")
  const { exitCode, stderr } = await $.process.run([exe, url], { cwd: paths.system32 })
  if (exitCode !== 0 && stderr.trim() !== '') throw new Error(stderr.trim())
}

/**
 * Switches the desktop app to an existing session through its deep link, the
 * route the POC verified: it focuses that session and never creates one.
 */
export async function openDesktopSession($: EngineInterface, paths: Paths, localId: string): Promise<void> {
  if (!isDesktopSessionId(localId)) throw new Error(`not a desktop session id: ${localId}`)
  await launchLink($, paths, openSessionLink(localId))
}

/**
 * Opens Claude desktop's new-session page for `folderText` with `prompt` in
 * the composer, through the documented `claude://code/new` link. Claude asks
 * the person to confirm the folder and sends nothing until they do.
 */
export async function startNewSession($: EngineInterface, paths: Paths, folderText: string, prompt: string): Promise<{ ok: boolean; message: string }> {
  const checked = checkNewSession(folderText, prompt)
  if (!checked.ok) return { ok: false, message: checked.error }
  const stat = await $.fs.stat(checked.folder).catch(() => null)
  if (!stat || stat.kind !== 'dir') return { ok: false, message: `No folder at ${checked.folder}.` }
  await launchLink($, paths, checked.link)
  return { ok: true, message: 'Opened in Claude. Press Enter there to send.' }
}
