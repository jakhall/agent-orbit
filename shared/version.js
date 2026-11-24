// @ts-check

/**
 * True when `version` is an older `major.minor.patch` than `than`; a
 * missing or malformed version counts as older.
 * @param {string | undefined} version
 * @param {string} than
 * @returns {boolean}
 */
export function isOlderVersion(version, than) {
  if (typeof version !== 'string') return true
  const a = version.split('.').map(n => Number.parseInt(n, 10))
  const b = than.split('.').map(n => Number.parseInt(n, 10))
  for (let i = 0; i < 3; i += 1) {
    const x = Number.isFinite(a[i]) ? /** @type {number} */ (a[i]) : 0
    const y = Number.isFinite(b[i]) ? /** @type {number} */ (b[i]) : 0
    if (x !== y) return x < y
  }
  return false
}
