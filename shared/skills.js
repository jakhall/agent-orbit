// @ts-check
/** @typedef {import('../types').SkillShelf} SkillShelf */
/** @typedef {import('../types').SkillShelfGroup} SkillShelfGroup */
/** @typedef {import('../types').SkillShelfItem} SkillShelfItem */

import { MAX_MESSAGE_CHARS } from './constants.js'
import { checkReplyText, isCommandAllowed, parseCommand } from './inbox.js'
import { isPrUrl } from './pr-links.js'

export const SHELF_MAX_GROUPS = 20
export const SHELF_MAX_GROUP_ITEMS = 50
export const SHELF_MAX_ITEMS = 200
export const SHELF_NAME_MAX = 60

/** The icons a shelf skill may wear, in picker order, with their names; `skill` (the wand) is the default and never stored. */
export const SKILL_ICONS = Object.freeze({
  skill: 'Wand',
  bulb: 'Bulb',
  rocket: 'Rocket',
  bug: 'Bug',
  shield: 'Shield',
  book: 'Book',
  beaker: 'Beaker',
  sparkle: 'Sparkle',
  terminal: 'Terminal',
  code: 'Code',
  gear: 'Gear',
  wrench: 'Wrench',
  note: 'Note',
  star: 'Star',
  heart: 'Heart',
  lock: 'Lock',
  database: 'Database',
  chart: 'Chart',
  bolt: 'Bolt',
  flag: 'Flag',
  eye: 'Eye',
  diff: 'Diff',
  pr: 'Pull request',
  search: 'Search',
  send: 'Send',
  check: 'Check',
  objective: 'Target',
  remote: 'Globe',
  turns: 'Chat',
  person: 'Person',
})

/** The colours a shelf skill's icon may take, with their names; none (grey) is the default. */
export const SKILL_COLORS = Object.freeze({ blue: 'Blue', green: 'Green', amber: 'Amber', red: 'Red', violet: 'Violet', teal: 'Teal' })

const GROUP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function skillIconName(value) {
  return typeof value === 'string' && value !== 'skill' && Object.hasOwn(SKILL_ICONS, value) ? value : null
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function skillColorName(value) {
  return typeof value === 'string' && Object.hasOwn(SKILL_COLORS, value) ? value : null
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {}
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function shortName(value) {
  if (typeof value !== 'string') return null
  const text = [...value].map(ch => (isKeptChar(/** @type {number} */ (ch.codePointAt(0))) && ch !== '\n' && ch !== '\t' ? ch : ' ')).join('').replace(/\s+/g, ' ').trim()
  return text ? [...text].slice(0, SHELF_NAME_MAX).join('').trim() : null
}

/**
 * @param {number} code
 */
function isKeptChar(code) {
  if (code === 9 || code === 10) return true
  return !(code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029)
}

/**
 * A saved default prompt: line breaks and tabs kept, other control
 * characters dropped, at most `MAX_MESSAGE_CHARS`; null when blank.
 * @param {unknown} value
 * @returns {string | null}
 */
export function cleanTemplate(value) {
  if (typeof value !== 'string') return null
  const text = [...value.replace(/\r\n?/g, '\n')].filter(ch => isKeptChar(/** @type {number} */ (ch.codePointAt(0)))).join('').trim()
  return text ? [...text].slice(0, MAX_MESSAGE_CHARS).join('').trim() : null
}

/**
 * The person's curated skill shelf as every reader and writer must see it:
 * at most `SHELF_MAX_GROUPS` groups with unique ids, at most
 * `SHELF_MAX_GROUP_ITEMS` items each and `SHELF_MAX_ITEMS` in all, every
 * command one Orbit may send, each command once per group.
 * @param {unknown} raw
 * @returns {SkillShelf}
 */
export function sanitizeSkillShelf(raw) {
  const rawGroups = record(raw).groups
  /** @type {SkillShelfGroup[]} */
  const groups = []
  const ids = new Set()
  let total = 0
  for (const [index, entry] of (Array.isArray(rawGroups) ? rawGroups : []).entries()) {
    if (groups.length >= SHELF_MAX_GROUPS) break
    const g = record(entry)
    if (!Object.keys(g).length) continue
    let id = typeof g.id === 'string' && GROUP_ID.test(g.id) && !ids.has(g.id) ? g.id : `g${index}`
    while (ids.has(id)) id = `${id}-x`
    ids.add(id)
    /** @type {SkillShelfItem[]} */
    const items = []
    const commands = new Set()
    for (const value of Array.isArray(g.items) ? g.items : []) {
      if (items.length >= SHELF_MAX_GROUP_ITEMS || total >= SHELF_MAX_ITEMS) break
      const item = record(value)
      const command = typeof item.command === 'string' ? item.command.trim().replace(/^\//, '') : ''
      if (!isCommandAllowed(command) || commands.has(command)) continue
      commands.add(command)
      const template = cleanTemplate(item.template)
      const icon = skillIconName(item.icon)
      const color = skillColorName(item.color)
      items.push({ command, label: shortName(item.label) ?? command, ...(template ? { template } : {}), ...(icon ? { icon } : {}), ...(color ? { color } : {}) })
      total += 1
    }
    groups.push({ id, name: shortName(g.name) ?? 'Skills', items })
  }
  return { groups }
}

/**
 * @typedef {{ name: string, description?: string, source?: string, plugin?: string }} ListedCommand
 * @typedef {SkillShelfItem & { groupId: string, available: boolean, reason: string | null, description: string }} ShelfViewItem
 * @typedef {{ id: string, name: string, items: ShelfViewItem[] }} ShelfViewGroup
 */

/**
 * The shelf as one session sees it: each item marked available when that
 * session lists its command, with a reason when it does not. `commands` null
 * means the session has not published a list. `filter` keeps items whose
 * label, command or group name contains it; groups left empty by a filter
 * are dropped.
 * @param {SkillShelf | null | undefined} shelf
 * @param {ListedCommand[] | null} commands
 * @param {string} [filter]
 * @returns {ShelfViewGroup[]}
 */
export function shelfView(shelf, commands, filter = '') {
  const listed = new Map((commands ?? []).map(c => [c.name.toLowerCase(), c]))
  const needle = filter.trim().toLowerCase()
  /** @type {ShelfViewGroup[]} */
  const out = []
  for (const group of shelf?.groups ?? []) {
    const groupHit = needle !== '' && group.name.toLowerCase().includes(needle)
    const items = group.items
      .filter(item => !needle || groupHit || item.label.toLowerCase().includes(needle) || item.command.toLowerCase().includes(needle))
      .map(item => {
        const found = listed.get(item.command.toLowerCase())
        const reason = commands === null ? 'This session hasn’t shared its commands yet.' : found ? null : 'Not in this session.'
        return { ...item, groupId: group.id, available: reason === null, reason, description: found?.description ?? '' }
      })
    if (items.length || !needle) out.push({ id: group.id, name: group.name, items })
  }
  return out
}

/**
 * The line Apply sends: `/command` alone, or `/command prompt` with the
 * prompt trimmed, then the pull request link when one is given. Null when
 * the command is not one Orbit may send or the link is not a plain GitHub PR.
 * @param {string} command
 * @param {string} [prompt]
 * @param {string | null} [prUrl]
 * @returns {string | null}
 */
export function skillLine(command, prompt = '', prUrl = null) {
  const name = typeof command === 'string' ? command.trim().replace(/^\//, '') : ''
  if (!isCommandAllowed(name)) return null
  if (prUrl && !isPrUrl(prUrl)) return null
  const rest = [typeof prompt === 'string' ? prompt.trim() : '', prUrl ?? ''].filter(Boolean).join(' ')
  return rest ? `/${name} ${rest}` : `/${name}`
}

/**
 * @param {SkillShelf | null | undefined} shelf
 * @returns {number}
 */
export function shelfCount(shelf) {
  return (shelf?.groups ?? []).reduce((sum, g) => sum + g.items.length, 0)
}

/**
 * How many more skills `group` can take, given `total` skills on the shelf.
 * @param {SkillShelfGroup} group
 * @param {number} total
 * @returns {number}
 */
export function shelfRoom(group, total) {
  return Math.min(SHELF_MAX_GROUP_ITEMS - group.items.length, SHELF_MAX_ITEMS - total)
}

/**
 * One page of `list`, with `page` clamped to the pages there are (always at least one).
 * @template T
 * @param {T[]} list
 * @param {number} page
 * @param {number} size
 * @returns {{ items: T[], page: number, pages: number, start: number }}
 */
export function pageSlice(list, page, size) {
  const pages = Math.max(1, Math.ceil(list.length / size))
  const at = Math.min(Math.max(0, Math.trunc(page) || 0), pages - 1)
  const start = at * size
  return { items: list.slice(start, start + size), page: at, pages, start }
}

/**
 * @param {SkillShelf | null | undefined} shelf
 * @param {(groups: SkillShelfGroup[]) => void} change
 * @returns {SkillShelf}
 */
function edited(shelf, change) {
  const groups = (shelf?.groups ?? []).map(g => ({ ...g, items: g.items.map(i => ({ ...i })) }))
  change(groups)
  return sanitizeSkillShelf({ groups })
}

/**
 * @template T
 * @param {T[]} list
 * @param {number} from
 * @param {number} delta
 */
function shift(list, from, delta) {
  const to = from + delta
  if (from < 0 || to < 0 || to >= list.length) return
  list.splice(to, 0, ...list.splice(from, 1))
}

/**
 * Adds an empty group at the end. Null when the shelf already holds
 * `SHELF_MAX_GROUPS` groups.
 * @param {SkillShelf | null | undefined} shelf
 * @param {string} name
 * @returns {{ shelf: SkillShelf, id: string } | null}
 */
export function addShelfGroup(shelf, name) {
  const groups = shelf?.groups ?? []
  if (groups.length >= SHELF_MAX_GROUPS) return null
  const taken = new Set(groups.map(g => g.id))
  const base = (shortName(name) ?? 'skills').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'skills'
  let id = /^[a-z0-9]/.test(base) ? base : `g-${base}`
  for (let n = 2; taken.has(id); n += 1) id = `${base.slice(0, 30)}-${n}`
  return { shelf: edited(shelf, list => list.push({ id, name: shortName(name) ?? 'Skills', items: [] })), id }
}

/**
 * @param {SkillShelf | null | undefined} shelf
 * @param {string} groupId
 * @param {{ name?: string, move?: number, remove?: boolean }} change
 * @returns {SkillShelf}
 */
export function editShelfGroup(shelf, groupId, change) {
  return edited(shelf, list => {
    const at = list.findIndex(g => g.id === groupId)
    const group = list[at]
    if (!group) return
    if (change.remove) return void list.splice(at, 1)
    if (typeof change.name === 'string') group.name = shortName(change.name) ?? group.name
    if (change.move) shift(list, at, change.move)
  })
}

/**
 * @param {SkillShelf | null | undefined} shelf
 * @param {string} groupId
 * @param {string} command
 * @param {{ label?: string, template?: string, icon?: string, color?: string, move?: number, remove?: boolean }} change
 * `icon` 'skill' and `color` '' (or any name not in the sets) go back to the default.
 * @returns {SkillShelf}
 */
export function editShelfItem(shelf, groupId, command, change) {
  return edited(shelf, list => {
    const group = list.find(g => g.id === groupId)
    const at = group ? group.items.findIndex(i => i.command === command) : -1
    const item = group?.items[at]
    if (!group || !item) return
    if (change.remove) return void group.items.splice(at, 1)
    if (typeof change.label === 'string') item.label = shortName(change.label) ?? item.command
    if (typeof change.template === 'string') {
      const template = cleanTemplate(change.template)
      if (template) item.template = template
      else delete item.template
    }
    if (typeof change.icon === 'string') {
      const icon = skillIconName(change.icon)
      if (icon) item.icon = icon
      else delete item.icon
    }
    if (typeof change.color === 'string') {
      const color = skillColorName(change.color)
      if (color) item.color = color
      else delete item.color
    }
    if (change.move) shift(group.items, at, change.move)
  })
}

/**
 * Adds commands to a group, skipping ones Orbit may not send, ones already
 * in the group, and any past the caps.
 * @param {SkillShelf | null | undefined} shelf
 * @param {string} groupId
 * @param {string[]} commands
 * @returns {{ shelf: SkillShelf, added: number, skipped: number }}
 */
export function addShelfItems(shelf, groupId, commands) {
  const group = shelf?.groups.find(g => g.id === groupId)
  if (!group) return { shelf: sanitizeSkillShelf(shelf), added: 0, skipped: commands.length }
  const have = new Set(group.items.map(i => i.command))
  let room = shelfRoom(group, shelfCount(shelf))
  /** @type {string[]} */
  const fresh = []
  for (const raw of commands) {
    const command = typeof raw === 'string' ? raw.trim().replace(/^\//, '') : ''
    if (room <= 0 || !isCommandAllowed(command) || have.has(command)) continue
    have.add(command)
    fresh.push(command)
    room -= 1
  }
  const next = edited(shelf, list => list.find(g => g.id === groupId)?.items.push(...fresh.map(command => ({ command, label: command.slice(command.lastIndexOf(':') + 1) }))))
  return { shelf: next, added: fresh.length, skipped: commands.length - fresh.length }
}

/**
 * @typedef {{ name: string, description?: string, source?: string, plugin?: string, sessions?: number }} CatalogCommand
 */

/**
 * What the Settings picker offers for one group: catalog commands not yet in
 * it whose name, description or plugin contains `query` (at most `limit`),
 * and per plugin whose name contains `query`, all of its commands not yet in
 * the group (only when more than one), for "Add all from plugin".
 * @param {CatalogCommand[]} catalog
 * @param {SkillShelfGroup | undefined} group
 * @param {string} query
 * @param {number} [limit]
 * @returns {{ matches: CatalogCommand[], more: number, plugins: { plugin: string, commands: string[] }[] }}
 */
export function catalogPicks(catalog, group, query, limit = 20) {
  const have = new Set((group?.items ?? []).map(i => i.command))
  const needle = query.trim().toLowerCase().replace(/^\//, '')
  const open = catalog.filter(c => isCommandAllowed(c.name) && !have.has(c.name))
  const hits = open.filter(c => !needle || c.name.toLowerCase().includes(needle) || (c.description ?? '').toLowerCase().includes(needle) || (c.plugin ?? '').toLowerCase().includes(needle))
  const pluginNames = [...new Set(open.map(c => c.plugin).filter(p => typeof p === 'string' && p !== '' && p.toLowerCase().includes(needle)))].sort()
  const plugins = pluginNames.map(plugin => ({ plugin: /** @type {string} */ (plugin), commands: open.filter(c => c.plugin === plugin).map(c => c.name) })).filter(p => p.commands.length > 1)
  return { matches: hits.slice(0, limit), more: Math.max(0, hits.length - limit), plugins }
}

/**
 * Checks a New session first prompt. A leading `/command` passes only when
 * Orbit may send it and it is on the shelf; the new session still refuses it
 * if that session does not list the command.
 * @param {string} text
 * @param {SkillShelf | null | undefined} shelf
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function checkLaunchPrompt(text, shelf) {
  const commands = new Set((shelf?.groups ?? []).flatMap(g => g.items.map(i => i.command)))
  const checked = checkReplyText(text, commands)
  if (checked.ok) return { ok: true }
  if (checked.reason !== 'command') return { ok: false, error: checked.error }
  const command = parseCommand(text)
  if (!command) return { ok: false, error: 'A first prompt can’t start with ! or an unknown /.' }
  if (!isCommandAllowed(command.name)) return { ok: false, error: `/${command.name} changes settings or access, so Orbit never runs it: type it in the new session instead.` }
  return { ok: false, error: `/${command.name} isn’t in your Skills; add it in Settings → Skills.` }
}
