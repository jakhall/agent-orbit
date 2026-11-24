export const AUDIT_MAX_BYTES = 1024 * 1024
const KINDS = new Set(['arm', 'approval', 'question', 'reply', 'command', 'stop', 'alert'])
const FIELDS = ['capability', 'armed', 'id', 'session', 'tool', 'inputHash', 'outcome', 'where', 'what', 'window', 'agent']
const ID = /^[0-9a-zA-Z_:.-]{1,100}$/

/**
 * One audit line (E-22) from allow-listed, short fields only: never prompt,
 * reply, question or tool-input text.
 * @param {Record<string, unknown>} event
 * @param {number} at
 * @returns {Record<string, unknown> | null}
 */
export function auditLine(event, at) {
  if (!KINDS.has(/** @type {string} */ (event.kind))) return null
  /** @type {Record<string, unknown>} */
  const line = { at, kind: event.kind }
  for (const field of FIELDS) {
    const value = event[field]
    if (typeof value === 'boolean') line[field] = value
    else if (typeof value === 'string' && (field === 'inputHash' ? /^[0-9a-f]{64}$/.test(value) : ID.test(value) || /^[a-z][a-z :-]{0,39}$/.test(value))) line[field] = value
  }
  return line
}

/**
 * The append-only audit record (`audit.jsonl`, E-22): arm changes,
 * approvals and questions with their outcome, replies, slash commands run
 * from Orbit (the name only), stops (with the sub-agent's id when one was
 * targeted), alerts. Rotated once
 * to `audit.1.jsonl` past 1 MB.
 * @param {{ append: (text: string) => void, size: () => number, rotate: () => void, read: () => string[], now?: () => number }} io
 */
export function createAudit({ append, size, rotate, read, now = Date.now }) {
  return {
    /** @param {Record<string, unknown>} event */
    record(event) {
      const line = auditLine(event, now())
      if (!line) return
      try {
        if (size() > AUDIT_MAX_BYTES) rotate()
        append(`${JSON.stringify(line)}\n`)
      } catch {}
    },
    /** The newest `limit` lines, newest first. */
    recent(limit) {
      const lines = []
      for (const text of read()) {
        for (const raw of text.split('\n')) {
          if (!raw) continue
          try {
            lines.push(JSON.parse(raw))
          } catch {}
        }
      }
      return lines.reverse().slice(0, limit)
    },
  }
}

const REQUEST_FILE = /^[0-9a-f-]{36}(\.answer|\.done)?\.json$/i

/**
 * Files in Orbit's folders that the server no longer writes and nothing may
 * act on (A5): approval request, answer and done files, and reply requests
 * in a session's inbox. They are refused (deleted) and shown as an alert;
 * acknowledgements, withdrawal markers and `seen.json` are left alone.
 * @param {'approvals' | 'inbox'} where
 * @param {string} name
 * @returns {'request' | 'answer' | null}
 */
export function forgedKind(where, name) {
  const match = REQUEST_FILE.exec(name)
  if (!match) return null
  if (where === 'approvals') return match[1] === '.answer' ? 'answer' : 'request'
  return match[1] ? null : 'request'
}
