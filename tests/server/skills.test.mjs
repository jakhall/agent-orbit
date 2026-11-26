import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_MESSAGE_CHARS } from '../../shared/constants.js'
import { sanitizePrefs } from '../../shared/prefs.js'
import { SKILL_COLORS, SKILL_ICONS, SHELF_MAX_GROUP_ITEMS, SHELF_MAX_GROUPS, SHELF_MAX_ITEMS, addShelfGroup, pageSlice, shelfRoom, addShelfItems, catalogPicks, checkLaunchPrompt, cleanTemplate, editShelfGroup, editShelfItem, sanitizeSkillShelf, shelfCount, shelfView, skillLine } from '../../shared/skills.js'

const ESC = String.fromCharCode(27)
const BELL = String.fromCharCode(7)

test('a shelf keeps allowed commands once per group, with one-line labels and names', () => {
  const shelf = sanitizeSkillShelf({
    groups: [
      {
        id: 'toolbox',
        name: `  Tool${ESC}box\n  `,
        items: [
          { command: '/agent-toolbox:tb-code-review', label: 'Review\nit', template: 'Focus on ' },
          { command: 'agent-toolbox:tb-code-review', label: 'again' },
          { command: 'config', label: 'denied' },
          { command: 'bad name!', label: 'invalid' },
          { command: 'ab-grilling' },
        ],
      },
    ],
  })
  assert.deepEqual(shelf, {
    groups: [
      {
        id: 'toolbox',
        name: 'Tool box',
        items: [
          { command: 'agent-toolbox:tb-code-review', label: 'Review it', template: 'Focus on' },
          { command: 'ab-grilling', label: 'ab-grilling' },
        ],
      },
    ],
  })
})

test('a skill keeps a known icon and colour; the wand, unknown names and junk are dropped', () => {
  const items = sanitizeSkillShelf({
    groups: [
      {
        id: 'a',
        name: 'A',
        items: [
          { command: 'greenlight', icon: 'bulb', color: 'green' },
          { command: 'b', icon: 'skill', color: 'pink' },
          { command: 'c', icon: 'toString', color: 'constructor' },
          { command: 'd', icon: 5, color: {} },
        ],
      },
    ],
  }).groups[0].items
  assert.deepEqual(items, [
    { command: 'greenlight', label: 'greenlight', icon: 'bulb', color: 'green' },
    { command: 'b', label: 'b' },
    { command: 'c', label: 'c' },
    { command: 'd', label: 'd' },
  ])
})

test('editShelfItem sets an icon and colour and resets them to the default', () => {
  let shelf = sanitizeSkillShelf({ groups: [{ id: 'a', name: 'A', items: [{ command: 'x' }] }] })
  shelf = editShelfItem(shelf, 'a', 'x', { icon: 'rocket', color: 'violet' })
  assert.deepEqual(shelf.groups[0].items[0], { command: 'x', label: 'x', icon: 'rocket', color: 'violet' })
  shelf = editShelfItem(shelf, 'a', 'x', { label: 'X' })
  assert.equal(shelf.groups[0].items[0].icon, 'rocket', 'other edits keep the icon')
  shelf = editShelfItem(shelf, 'a', 'x', { icon: 'skill', color: '' })
  assert.deepEqual(shelf.groups[0].items[0], { command: 'x', label: 'X' })
  shelf = editShelfItem(shelf, 'a', 'x', { icon: 'nope', color: 'nope' })
  assert.deepEqual(shelf.groups[0].items[0], { command: 'x', label: 'X' })
})

test('every skill icon has artwork in the page icon set, the wand first', async () => {
  const fs = await import('node:fs')
  const source = fs.readFileSync(new URL('../../companion/inbox/icons.js', import.meta.url), 'utf8')
  const names = Object.keys(SKILL_ICONS)
  assert.equal(names[0], 'skill')
  for (const name of names) assert.match(source, new RegExp(`^  '?${name}'?: `, 'm'), `${name} is drawn in icons.js`)
  const css = fs.readFileSync(new URL('../../companion/inbox/base.css', import.meta.url), 'utf8')
  for (const color of Object.keys(SKILL_COLORS)) assert.ok(css.includes(`.c-${color} {\n  --sk: var(`), `${color} has a style`)
})

test('a shelf tolerates junk and absence', () => {
  assert.deepEqual(sanitizeSkillShelf(undefined), { groups: [] })
  assert.deepEqual(sanitizeSkillShelf({ groups: 'no' }), { groups: [] })
  assert.deepEqual(sanitizeSkillShelf({ groups: [null, 3, {}] }), { groups: [] })
  assert.deepEqual(sanitizeSkillShelf({ groups: [{ name: '' }] }), { groups: [{ id: 'g0', name: 'Skills', items: [] }] })
})

test('group ids are unique and well formed', () => {
  const shelf = sanitizeSkillShelf({ groups: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }, { id: 'Bad Id', name: 'C' }, { id: 'g1', name: 'D' }] })
  const ids = shelf.groups.map(g => g.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids[0], 'a')
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9-]*$/)
})

test('a command may sit in more than one group', () => {
  const shelf = sanitizeSkillShelf({ groups: [{ id: 'a', name: 'A', items: [{ command: 'x' }] }, { id: 'b', name: 'B', items: [{ command: 'x' }] }] })
  assert.deepEqual(shelf.groups.map(g => g.items.length), [1, 1])
})

test('caps: groups, items per group, items in all, name and label length', () => {
  const many = n => Array.from({ length: n }, (_, i) => ({ command: `c${i}`, label: 'x'.repeat(200) }))
  const shelf = sanitizeSkillShelf({ groups: Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, name: 'n'.repeat(200), items: many(80) })) })
  assert.equal(shelf.groups.length, SHELF_MAX_GROUPS)
  assert.equal(shelf.groups[0].items.length, SHELF_MAX_GROUP_ITEMS)
  assert.equal(shelf.groups.reduce((sum, g) => sum + g.items.length, 0), SHELF_MAX_ITEMS)
  assert.equal(shelf.groups[0].name.length, 60)
  assert.equal(shelf.groups[0].items[0].label.length, 60)
})

test('templates keep line breaks and tabs, drop other control characters, and are capped', () => {
  assert.equal(cleanTemplate(`a\r\n\tb${BELL}c${ESC}`), 'a\n\tbc')
  assert.equal(cleanTemplate('   '), null)
  assert.equal(cleanTemplate(5), null)
  assert.equal(cleanTemplate('y'.repeat(MAX_MESSAGE_CHARS + 50)).length, MAX_MESSAGE_CHARS)
})

test('sanitizePrefs carries the shelf and defaults it to empty', () => {
  assert.deepEqual(sanitizePrefs({}).skillShelf, { groups: [] })
  assert.equal(sanitizePrefs({ skillShelf: { groups: [{ id: 'a', name: 'A', items: [{ command: 'x' }] }] } }).skillShelf?.groups[0].items[0].command, 'x')
})

const SHELF = sanitizeSkillShelf({
  groups: [
    { id: 'toolbox', name: 'Toolbox', items: [{ command: 'agent-toolbox:tb-code-review', label: 'Review' }, { command: 'agent-toolbox:tb-qa', label: 'QA pass' }] },
    { id: 'daily', name: 'Daily', items: [{ command: 'ab-grilling', label: 'Grill me' }] },
  ],
})
const LISTED = [{ name: 'agent-toolbox:tb-code-review', description: 'Review the diff', source: 'plugin', plugin: 'agent-toolbox' }, { name: 'AB-Grilling', description: 'Interview', source: 'user' }]

test('shelfView marks what the session lists and says why the rest is greyed', () => {
  const view = shelfView(SHELF, LISTED)
  const items = view.flatMap(g => g.items)
  assert.deepEqual(items.map(i => [i.command, i.available]), [['agent-toolbox:tb-code-review', true], ['agent-toolbox:tb-qa', false], ['ab-grilling', true]])
  assert.equal(items[0].description, 'Review the diff')
  assert.equal(items[0].groupId, 'toolbox')
  assert.equal(items[1].reason, 'Not in this session.')
  const unknown = shelfView(SHELF, null).flatMap(g => g.items)
  assert.ok(unknown.every(i => !i.available && i.reason === 'This session hasn’t shared its commands yet.'))
})

test('shelfView filters by label, command or group name, dropping emptied groups', () => {
  assert.deepEqual(shelfView(SHELF, LISTED, 'qa').map(g => [g.id, g.items.map(i => i.label)]), [['toolbox', ['QA pass']]])
  assert.deepEqual(shelfView(SHELF, LISTED, 'grilling').map(g => g.id), ['daily'])
  assert.deepEqual(shelfView(SHELF, LISTED, 'daily').map(g => [g.id, g.items.length]), [['daily', 1]])
  assert.deepEqual(shelfView(SHELF, LISTED, 'nothing'), [])
  assert.equal(shelfView({ groups: [{ id: 'e', name: 'Empty', items: [] }] }, LISTED).length, 1, 'an empty group shows when nothing is filtered')
  assert.deepEqual(shelfView(undefined, LISTED), [])
})

test('skillLine builds the slash line and refuses what Orbit may not send', () => {
  assert.equal(skillLine('agent-toolbox:tb-code-review', '  focus on auth  '), '/agent-toolbox:tb-code-review focus on auth')
  assert.equal(skillLine('/ab-grilling'), '/ab-grilling')
  assert.equal(skillLine('ab-grilling', '   '), '/ab-grilling')
  assert.equal(skillLine('config', 'x'), null)
  assert.equal(skillLine('bad name', 'x'), null)
  const url = 'https://github.com/acme/app/pull/42'
  assert.equal(skillLine('greenlight', '', url), `/greenlight ${url}`)
  assert.equal(skillLine('agent-toolbox:tb-code-review', ' pr ', url), `/agent-toolbox:tb-code-review pr ${url}`)
  assert.equal(skillLine('greenlight', 'x', null), '/greenlight x')
  assert.equal(skillLine('greenlight', 'x', 'https://github.com/acme/app/pull/42?x=1'), null)
  assert.equal(skillLine('config', '', url), null)
})

test('groups are added with unique ids, renamed, moved and removed', () => {
  const first = addShelfGroup(null, 'Tool box!')
  assert.equal(first?.id, 'tool-box')
  const second = addShelfGroup(first?.shelf, 'Tool box')
  assert.equal(second?.id, 'tool-box-2')
  const odd = addShelfGroup(second?.shelf, '***')
  assert.equal(odd?.id, 'skills')
  let shelf = /** @type {any} */ (odd).shelf
  shelf = editShelfGroup(shelf, 'skills', { move: -1 })
  assert.deepEqual(shelf.groups.map(g => g.id), ['tool-box', 'skills', 'tool-box-2'])
  shelf = editShelfGroup(shelf, 'tool-box', { move: -1 })
  assert.deepEqual(shelf.groups.map(g => g.id), ['tool-box', 'skills', 'tool-box-2'])
  shelf = editShelfGroup(shelf, 'skills', { name: `  Plan${ESC}ning\n ` })
  assert.equal(shelf.groups[1].name, 'Plan ning')
  shelf = editShelfGroup(shelf, 'skills', { name: '   ' })
  assert.equal(shelf.groups[1].name, 'Plan ning')
  shelf = editShelfGroup(shelf, 'tool-box-2', { remove: true })
  assert.deepEqual(shelf.groups.map(g => g.id), ['tool-box', 'skills'])
  let full = { groups: [] }
  for (let i = 0; i < SHELF_MAX_GROUPS; i += 1) full = /** @type {any} */ (addShelfGroup(full, `g${i}`)).shelf
  assert.equal(addShelfGroup(full, 'one more'), null)
})

test('items are added once, past denied names and caps, then renamed, moved and given prompts', () => {
  const start = /** @type {any} */ (addShelfGroup(null, 'Toolbox')).shelf
  const added = addShelfItems(start, 'toolbox', ['/agent-toolbox:tb-code-review', 'agent-toolbox:tb-code-review', 'config', 'bad name!', 'ab-grilling'])
  assert.equal(added.added, 2)
  assert.equal(added.skipped, 3)
  assert.deepEqual(added.shelf.groups[0].items, [
    { command: 'agent-toolbox:tb-code-review', label: 'tb-code-review' },
    { command: 'ab-grilling', label: 'ab-grilling' },
  ])
  assert.equal(addShelfItems(added.shelf, 'missing', ['ab-grilling']).added, 0)
  let shelf = editShelfItem(added.shelf, 'toolbox', 'ab-grilling', { label: 'Grill me', template: `Ask ${BELL}me`, move: -1 })
  assert.deepEqual(shelf.groups[0].items[0], { command: 'ab-grilling', label: 'Grill me', template: 'Ask me' })
  shelf = editShelfItem(shelf, 'toolbox', 'ab-grilling', { template: '  ', label: ' ' })
  assert.deepEqual(shelf.groups[0].items[0], { command: 'ab-grilling', label: 'ab-grilling' })
  shelf = editShelfItem(shelf, 'toolbox', 'ab-grilling', { remove: true })
  assert.deepEqual(shelf.groups[0].items.map(i => i.command), ['agent-toolbox:tb-code-review'])
  const many = Array.from({ length: SHELF_MAX_GROUP_ITEMS + 5 }, (_, i) => `skill-${i}`)
  const capped = addShelfItems(start, 'toolbox', many)
  assert.equal(capped.added, SHELF_MAX_GROUP_ITEMS)
  assert.equal(shelfCount(capped.shelf), SHELF_MAX_GROUP_ITEMS)
  let wide = { groups: [] }
  for (let g = 0; g < 5; g += 1) {
    const made = /** @type {any} */ (addShelfGroup(wide, `g${g}`))
    wide = addShelfItems(made.shelf, made.id, many).shelf
  }
  assert.equal(shelfCount(wide), SHELF_MAX_ITEMS)
})

test('the catalog picker hides what the group holds and offers whole plugins', () => {
  const catalog = [
    { name: 'agent-toolbox:tb-code-review', description: 'Review a diff', plugin: 'agent-toolbox' },
    { name: 'agent-toolbox:tb-grill', description: 'Grill a plan', plugin: 'agent-toolbox' },
    { name: 'agent-toolbox:tb-notes', description: 'Notes', plugin: 'agent-toolbox' },
    { name: 'ab-code-planning', description: 'Plan the change' },
    { name: 'config', description: 'Settings' },
  ]
  const group = { id: 'toolbox', name: 'Toolbox', items: [{ command: 'agent-toolbox:tb-notes', label: 'Notes' }] }
  const all = catalogPicks(catalog, group, '')
  assert.deepEqual(all.matches.map(c => c.name), ['agent-toolbox:tb-code-review', 'agent-toolbox:tb-grill', 'ab-code-planning'])
  assert.deepEqual(all.plugins, [{ plugin: 'agent-toolbox', commands: ['agent-toolbox:tb-code-review', 'agent-toolbox:tb-grill'] }])
  const plan = catalogPicks(catalog, group, '/PLAN')
  assert.deepEqual(plan.matches.map(c => c.name), ['agent-toolbox:tb-grill', 'ab-code-planning'])
  assert.deepEqual(catalogPicks(catalog, group, 'review').plugins, [])
  const limited = catalogPicks(catalog, undefined, '', 2)
  assert.equal(limited.matches.length, 2)
  assert.equal(limited.more, 2)
})

test('a New session first prompt may start with a shelf skill only', () => {
  const shelf = sanitizeSkillShelf({ groups: [{ id: 'tb', name: 'Toolbox', items: [{ command: 'agent-toolbox:tb-grill' }] }] })
  assert.deepEqual(checkLaunchPrompt('plain words', shelf), { ok: true })
  assert.deepEqual(checkLaunchPrompt('/agent-toolbox:tb-grill', shelf), { ok: true })
  assert.deepEqual(checkLaunchPrompt('/agent-toolbox:tb-grill grill the plan', shelf), { ok: true })
  assert.match(checkLaunchPrompt('/agent-toolbox:tb-notes x', shelf).error, /isn’t in your Skills/)
  assert.match(checkLaunchPrompt('/config', shelf).error, /never runs it/)
  assert.match(checkLaunchPrompt('/clear', shelf).error, /isn’t in your Skills/)
  assert.match(checkLaunchPrompt('!rm -rf', shelf).error, /can’t start with/)
  assert.deepEqual(checkLaunchPrompt('#482 review this', shelf), { ok: true })
  assert.match(checkLaunchPrompt('/agent-toolbox:tb-grill', null).error, /isn’t in your Skills/)
})

test('pages clamp to the ones there are, and room counts both limits', () => {
  const list = Array.from({ length: 23 }, (_, i) => i)
  assert.deepEqual(pageSlice(list, 0, 10), { items: list.slice(0, 10), page: 0, pages: 3, start: 0 })
  assert.deepEqual(pageSlice(list, 2, 10), { items: [20, 21, 22], page: 2, pages: 3, start: 20 })
  assert.equal(pageSlice(list, 9, 10).page, 2)
  assert.equal(pageSlice(list, -1, 10).page, 0)
  assert.deepEqual(pageSlice([], 4, 10), { items: [], page: 0, pages: 1, start: 0 })
  const group = { id: 'g', name: 'G', items: [{ command: 'a', label: 'a' }] }
  assert.equal(shelfRoom(group, 1), SHELF_MAX_GROUP_ITEMS - 1)
  assert.equal(shelfRoom(group, SHELF_MAX_ITEMS), 0)
})
