import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const CAPABILITIES = ['approvals', 'questions', 'replies']

const ARM_FILE = 'arm.json'
const KEY_FILE = 'arm.key'
const LEGACY_FILE = 'approvals/enabled.json'

/**
 * The arm switches (D-6): one per capability, default off, held in the
 * server's memory and written only by it to `arm.json` with a MAC, so a
 * file written by anything else arms nothing and is reported. The old
 * "Approve from Orbit" on (`approvals/enabled.json`) arms approvals and
 * questions once, when there is no `arm.json` yet; nothing is ever turned
 * off by a migration.
 * @param {{ read: (name: string) => string | null, write: (name: string, text: string) => void, now: () => number }} io
 */
export function createArm({ read, write, now }) {
  let key = read(KEY_FILE)
  const hadKey = Boolean(key && /^[0-9a-f]{64}$/.test(key))
  if (!hadKey) {
    key = randomBytes(32).toString('hex')
    write(KEY_FILE, key)
  }
  const macOf = text => createHmac('sha256', key).update(text).digest('hex')
  /** @type {Record<string, { armed: boolean, at: number | null, source: 'default' | 'window' | 'migrated' }>} */
  const state = Object.fromEntries(CAPABILITIES.map(c => [c, { armed: false, at: null, source: 'default' }]))
  let tampered = false
  /** @type {string[]} */
  let restored = []

  const save = () => {
    const text = JSON.stringify(state)
    write(ARM_FILE, JSON.stringify({ schema: 1, state: JSON.parse(text), mac: macOf(text) }, null, 1))
  }

  const stored = read(ARM_FILE)
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored)
      const text = JSON.stringify(parsed.state)
      const given = Buffer.from(String(parsed.mac ?? ''))
      const expected = Buffer.from(macOf(text))
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('mac')
      for (const c of CAPABILITIES) {
        const s = parsed.state?.[c]
        if (s && typeof s.armed === 'boolean') state[c] = { armed: s.armed, at: typeof s.at === 'number' ? s.at : null, source: s.source === 'migrated' ? 'migrated' : s.source === 'window' ? 'window' : 'default' }
      }
      restored = CAPABILITIES.filter(c => state[c].armed)
    } catch {
      tampered = true
      for (const c of CAPABILITIES) state[c] = { armed: false, at: null, source: 'default' }
      save()
    }
  } else if (hadKey) {
    tampered = true
    save()
  } else {
    let legacy = null
    try {
      legacy = JSON.parse(read(LEGACY_FILE) ?? 'null')
    } catch {}
    if (legacy?.enabled === true) {
      const at = now()
      state.approvals = { armed: true, at, source: 'migrated' }
      state.questions = { armed: true, at, source: 'migrated' }
    }
    save()
  }

  return {
    get tampered() {
      return tampered
    },
    /** What the stored file re-armed at start, for the audit record. */
    restored() {
      return [...restored]
    },
    /** @param {string} capability */
    isArmed(capability) {
      return state[capability]?.armed === true
    },
    /** @param {string} capability @param {boolean} armed */
    set(capability, armed) {
      if (!CAPABILITIES.includes(capability)) throw new Error('unknown capability')
      state[capability] = { armed, at: now(), source: 'window' }
      save()
      return this.view()
    },
    view() {
      return structuredClone(state)
    },
  }
}
