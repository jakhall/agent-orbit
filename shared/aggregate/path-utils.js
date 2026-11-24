// @ts-check

export { basename } from '../redact.js'

/**
 * @typedef {{
 *   fs: {
 *     list: (path: string) => Promise<{ name: string, kind: string, size: number, mtimeMs: number, isLink: boolean }[]>,
 *     read: (path: string) => Promise<string>,
 *     stat: (path: string) => Promise<{ kind: string, size: number, mtimeMs: number, isLink: boolean }>,
 *     exists: (path: string) => Promise<boolean>,
 *   }
 * }} Host
 */

/**
 * @param {string} sep
 * @param {...string} parts
 * @returns {string}
 */
export function joinWith(sep, ...parts) {
  return parts
    .filter(part => part !== '')
    .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(sep)
}

/**
 * @param {string} path
 * @returns {string}
 */
export function normalizePath(path) {
  return path.replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase()
}

/**
 * @template T
 * @param {Host} $
 * @param {string} path
 * @returns {Promise<T | undefined>}
 */
export async function readJson($, path) {
  try {
    return /** @type {T} */ (JSON.parse(await $.fs.read(path)))
  } catch {
    return undefined
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
