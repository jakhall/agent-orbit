export const LATENCY_SAMPLES = 50
export const LATENCY_MAX_MS = 10 * 60_000

function pushCapped(list, value) {
  list.push(value)
  if (list.length > LATENCY_SAMPLES) list.shift()
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

function summarize(list) {
  if (list.length === 0) return { samples: 0, last: null, p50: null, p95: null, max: null }
  const sorted = [...list].sort((a, b) => a - b)
  return { samples: list.length, last: list.at(-1), p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), max: sorted.at(-1) }
}

/**
 * How long a change in a watched folder takes to reach the snapshot and
 * then a window's paint (G-34). Only changes with a watch event behind
 * them count; a paint report covers every earlier pending change once,
 * whichever window paints first.
 */
export function createLatency() {
  const pending = new Map()
  const toSnapshot = []
  const toPaint = []
  return {
    changed(seq, eventAt, at) {
      if (typeof eventAt !== 'number') return
      pending.set(seq, eventAt)
      if (pending.size > LATENCY_SAMPLES) pending.delete(pending.keys().next().value)
      pushCapped(toSnapshot, Math.max(0, at - eventAt))
    },
    painted(seq, at) {
      let added = 0
      for (const [changedSeq, eventAt] of pending) {
        if (changedSeq > seq) continue
        pending.delete(changedSeq)
        const ms = at - eventAt
        if (ms < 0 || ms > LATENCY_MAX_MS) continue
        pushCapped(toPaint, ms)
        added += 1
      }
      return added
    },
    summary() {
      return { eventToSnapshotMs: summarize(toSnapshot), eventToPaintMs: summarize(toPaint) }
    },
  }
}
