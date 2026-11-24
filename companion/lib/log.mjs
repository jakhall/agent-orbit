const OWN_FRAME = /[\\/](companion|shared|src|hooks)[\\/](?:[^\\/:]+[\\/])*([^\\/:]+\.m?[jt]sx?):(\d+)/

/**
 * How an internal error is logged: its name and the first stack frame in
 * Orbit's own code as `file:line` (`TypeError at server.mjs:917`). Never
 * the message or a full path, which can hold prompt text or user folders.
 * @param {unknown} error
 * @returns {string}
 */
export function errorWhere(error) {
  const name = error instanceof Error ? error.name : 'Error'
  const stack = error instanceof Error ? String(error.stack ?? '') : ''
  for (const line of stack.split('\n').slice(1)) {
    const match = OWN_FRAME.exec(line)
    if (match) return `${name} at ${match[2]}:${match[3]}`
  }
  return name
}
