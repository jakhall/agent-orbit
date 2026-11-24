// @ts-check

const KNOWN = /** @type {Record<string, string>} */ ({
  refusal: 'The model refused the last turn',
  error: 'The last turn ended with an API error',
  disk_full: 'Claude could not start: disk full',
  spawn_failed: 'Claude could not start',
  cli_fastfail: 'Claude stopped right after starting',
  cwd_not_found: "The session's folder no longer exists",
  process_interrupted: "The session's process was interrupted",
  cli_shutdown_crash_benign: 'Claude exited while shutting down',
})

/**
 * The one line page, pane and server show for a failure category from the
 * desktop record or a turn's end; an unknown category is named in a safe
 * form, never echoed as written.
 * @param {string} category
 * @returns {string}
 */
export function failureText(category) {
  const known = KNOWN[category]
  if (known) return known
  const safe = String(category ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return safe ? `Failed (${safe})` : 'Failed'
}
