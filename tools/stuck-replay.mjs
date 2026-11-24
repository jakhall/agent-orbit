import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { STUCK, stuckOf } = await import(pathToFileURL(path.join(REPO, 'shared', 'aggregate', 'infer.js')).href)
const { categorizeTool } = await import(pathToFileURL(path.join(REPO, 'shared', 'redact.js')).href)

const projects = path.join(os.homedir(), '.claude', 'projects')
const sinceDays = Number(process.argv[2] ?? 14)
const minMtime = Date.now() - sinceDays * 86_400_000

function isPrompt(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return false
  const c = entry.message?.content
  if (typeof c === 'string') return c.trim() !== ''
  return Array.isArray(c) && c.some(b => b?.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
}

async function turnsOf(file) {
  const turns = []
  let turn = null
  const byId = new Map()
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"') && !line.includes('"type":"user"')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(entry.timestamp)
    if (!Number.isFinite(at)) continue
    if (isPrompt(entry)) {
      turn = { start: at, end: at, tools: [] }
      turns.push(turn)
      continue
    }
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : []
    for (const b of blocks) {
      if (entry.type === 'assistant' && b?.type === 'tool_use' && turn && !entry.isSidechain) {
        const { category, target } = categorizeTool(String(b.name), b.input && typeof b.input === 'object' ? b.input : {})
        const record = { at, tool: String(b.name), category, target, isError: false, agentId: null }
        turn.tools.push(record)
        byId.set(b.id, record)
        turn.end = at
      } else if (entry.type === 'user' && b?.type === 'tool_result') {
        const record = byId.get(b.tool_use_id)
        if (record && b.is_error === true) record.isError = true
        if (turn) turn.end = Math.max(turn.end, at)
      }
    }
  }
  return turns
}

const files = []
for (const dir of fs.readdirSync(projects)) {
  let names = []
  try {
    names = fs.readdirSync(path.join(projects, dir)).filter(n => n.endsWith('.jsonl'))
  } catch {
    continue
  }
  for (const name of names) {
    const file = path.join(projects, dir, name)
    if (fs.statSync(file).mtimeMs >= minMtime) files.push(file)
  }
}

const stats = { thresholds: STUCK, files: files.length, turns: 0, toolCalls: 0, points: 0, fired: { repeat: 0, errors: 0 }, turnsFired: { repeat: 0, errors: 0 } }
const examples = { repeat: new Map(), errors: [] }
for (const file of files) {
  for (const turn of await turnsOf(file)) {
    stats.turns += 1
    stats.toolCalls += turn.tools.length
    const fired = new Set()
    for (const [i, call] of turn.tools.entries()) {
      stats.points += 1
      const stuck = stuckOf(turn.tools.slice(0, i + 1), call.at, 'running', turn.start)
      if (!stuck) continue
      stats.fired[stuck.kind] += 1
      if (fired.has(stuck.kind)) continue
      fired.add(stuck.kind)
      stats.turnsFired[stuck.kind] += 1
      if (stuck.kind === 'repeat') {
        const tool = /: (\S+)/.exec(stuck.text)?.[1] ?? '?'
        examples.repeat.set(tool, [...(examples.repeat.get(tool) ?? []), stuck.text])
      } else examples.errors.push(stuck.text)
    }
  }
}
const percent = n => `${((n / Math.max(1, stats.turns)) * 100).toFixed(2)}% of turns`
console.log(JSON.stringify(stats, null, 1))
console.log(`\nrepeat: ${percent(stats.turnsFired.repeat)}; errors: ${percent(stats.turnsFired.errors)}`)
console.log('\nrepeat by tool:')
for (const [tool, texts] of [...examples.repeat.entries()].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${tool}: ${texts.length}  e.g. ${[...new Set(texts)].slice(0, 3).join(' ; ')}`)
