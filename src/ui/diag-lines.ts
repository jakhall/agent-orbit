import type { ErrorTrace } from '../../types'
import { plural, since } from '../../shared/format.js'
import { ARMED_LEAD, armedCapabilities } from '../../shared/popout.js'

/** The server's arm switches (D-6) in the page's words; `null` before the server has answered. */
export function armLine(armed: readonly string[] | null | undefined): string {
  if (!armed) return 'Remote control: not known yet'
  const on = armedCapabilities({ approvals: armed.includes('approvals'), questions: armed.includes('questions'), replies: armed.includes('replies') })
  return on.length === 0 ? 'Remote control: off' : `${ARMED_LEAD} ${on.map(c => c.label).join(', ')}`
}

export function noticeLine(notice: string | null | undefined): string {
  return `Notice: ${notice || 'none'}`
}

/** E-29: this session's mod failures, never their messages. */
export function errorsLine(errors: ErrorTrace | null | undefined, now: number): string {
  if (!errors) return 'Errors: none'
  return `Errors: ${plural(errors.count, 'error')}, last ${since(now - errors.lastAt)} in ${errors.where} (${errors.kind})`
}
