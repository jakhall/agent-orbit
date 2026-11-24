export const FOLLOW_DEBOUNCE_MS = 150

/**
 * Each window's selected session, followed live (E-110): the server watches
 * that one transcript and tells that window when it is written, so a chat
 * does not wait for the snapshot. One watch per window, dropped when the
 * selection changes or the window's stream closes.
 * @param {{
 *   resolve: (key: string) => Promise<string | null>,
 *   watch: (file: string, onChange: () => void) => () => void,
 *   send: (windowId: string, key: string) => void,
 *   debounceMs?: number,
 * }} io
 */
export function createTranscriptFollower({ resolve, watch, send, debounceMs = FOLLOW_DEBOUNCE_MS }) {
  /** @type {Map<string, { key: string, close: () => void, timer: ReturnType<typeof setTimeout> | null }>} */
  const byWindow = new Map()

  function stop(windowId) {
    const current = byWindow.get(windowId)
    if (!current) return
    if (current.timer) clearTimeout(current.timer)
    current.close()
    byWindow.delete(windowId)
  }

  async function follow(windowId, key) {
    if (byWindow.get(windowId)?.key === key) return
    stop(windowId)
    if (!key) return
    const file = await resolve(key)
    if (!file) return
    stop(windowId)
    const entry = { key, close: () => undefined, timer: null }
    entry.close = watch(file, () => {
      if (entry.timer) return
      entry.timer = setTimeout(() => {
        entry.timer = null
        send(windowId, key)
      }, debounceMs)
    })
    byWindow.set(windowId, entry)
  }

  return { follow, stop, size: () => byWindow.size }
}
