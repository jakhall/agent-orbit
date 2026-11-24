import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXCLUDED = ['hooks/approve.mjs', 'tests/server']

function arg(name) {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

function dotEnv(name) {
  let text
  try {
    text = fs.readFileSync(path.join(REPO, '.env'), 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (match?.[1] === name && match[2]) return match[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return undefined
}

function installedTsc() {
  const candidates = [
    path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(path.dirname(process.execPath), 'node_modules', 'typescript', 'bin', 'tsc'),
  ].filter(Boolean)
  return candidates.find((file) => safeStat(file)) ?? candidates[0]
}

function newestBundledDts() {
  const root = path.join(os.tmpdir(), 'claude', 'bundled-skills')
  const found = []
  for (const version of safeList(root)) {
    for (const hash of safeList(path.join(root, version))) {
      const file = path.join(root, version, hash, 'plugin-authoring', 'types', 'claude-code.d.ts')
      const stat = safeStat(file)
      if (stat) found.push({ file, mtimeMs: stat.mtimeMs })
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

const dts = arg('--dts') ?? process.env.ORBIT_DTS ?? newestBundledDts()
const tsc = arg('--tsc') ?? process.env.ORBIT_TSC ?? dotEnv('ORBIT_TSC') ?? installedTsc()
const repoTag = `${path.basename(REPO)}-${createHash('sha256').update(REPO.toLowerCase()).digest('hex').slice(0, 8)}`
const out = arg('--out') ?? path.join(os.tmpdir(), 'orbit-typecheck', repoTag)

if (!dts || !safeStat(dts)) {
  console.error(
    dts
      ? `typecheck: ${dts} does not exist. Pass --dts <file> to an existing claude-code.d.ts.`
      : 'typecheck: no claude-code.d.ts under %TEMP%\\claude\\bundled-skills (Windows clears %TEMP%). Load the plugin-authoring skill in any Claude session to regenerate it (it writes the file as it loads; write nothing under ~/.claude/dev-mods), then run this again, or pass --dts <file>.',
  )
  process.exit(2)
}
if (!safeStat(tsc)) {
  console.error(`typecheck: TypeScript not found at ${tsc}. Install it (npm install -g typescript), set ORBIT_TSC in the environment or in a .env file at the repo root, or pass --tsc <path to typescript/bin/tsc>.`)
  process.exit(2)
}
if (path.resolve(out).toLowerCase().startsWith(REPO.toLowerCase())) {
  console.error('typecheck: --out must be outside the repository (a live refresh mirrors the working tree).')
  process.exit(2)
}

const slash = p => p.split(path.sep).join('/')
const config = {
  compilerOptions: {
    target: 'es2023',
    lib: ['es2023'],
    types: [],
    module: 'esnext',
    moduleResolution: 'bundler',
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: true,
    jsx: 'react',
    jsxFactory: 'h',
    jsxFragmentFactory: 'Fragment',
    allowJs: true,
    checkJs: true,
  },
  files: [slash(path.resolve(dts))],
  include: ['hooks', 'src', 'shared', 'types', 'tests'].map(d => `${slash(REPO)}/${d}`),
  exclude: EXCLUDED.map(f => `${slash(REPO)}/${f}`),
}
fs.mkdirSync(out, { recursive: true })
const configFile = path.join(out, 'tsconfig.json')
fs.writeFileSync(configFile, JSON.stringify(config, null, 2))
console.log(`typecheck: ${slash(path.resolve(dts))}`)
console.log(`typecheck: ${slash(configFile)}`)
const run = spawnSync(process.execPath, [tsc, '-p', configFile, '--pretty', 'false'], { stdio: 'inherit' })

const UNDEFINED_NAME = /error TS(2304|2552):/
const pageConfig = {
  compilerOptions: { target: 'es2023', lib: ['es2023', 'dom', 'dom.iterable'], types: [], module: 'esnext', moduleResolution: 'bundler', noEmit: true, skipLibCheck: true, allowJs: true, checkJs: true },
  include: ['companion/inbox/**/*.js'].map(p => `${slash(REPO)}/${p}`),
}
const pageConfigFile = path.join(out, 'tsconfig.page.json')
fs.writeFileSync(pageConfigFile, JSON.stringify(pageConfig, null, 2))
console.log(`typecheck: ${slash(pageConfigFile)} (page modules: undefined names only, TS2304/TS2552)`)
const page = spawnSync(process.execPath, [tsc, '-p', pageConfigFile, '--pretty', 'false'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const undefinedNames = `${page.stdout ?? ''}`.split(/\r?\n/).filter(line => UNDEFINED_NAME.test(line))
for (const line of undefinedNames) console.log(line)
if (page.error) console.error(`typecheck: the page pass did not run: ${page.error.message}`)
process.exit(run.status !== 0 || undefinedNames.length > 0 || page.error ? 1 : 0)
