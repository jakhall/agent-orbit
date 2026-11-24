// @ts-check

/** @typedef {import('../types').ToolCategory} ToolCategory */

const TEST_RUNNER =
  /\b(pytest|py\.test|jest|vitest|mocha|ava|rspec|phpunit|playwright test|cypress run|go test|cargo test|dotnet test|mvn (-\S+ )*test|gradle(w)? test|ctest|tox|nox|unittest|bun test|deno test|(npm|pnpm|yarn)( run)? test(:\S+)?|claude plugin test|Invoke-Pester)\b/i
const MERGE = /\bgit (merge|rebase|cherry-pick|pull)\b|\bgh pr merge\b/i
const GIT_WRITE = /\bgit (commit|push|tag|switch -c|checkout -b)\b|\bgh pr (create|edit|ready)\b/i
const REVIEW = /\bgit (diff|show|blame)\b|\bgh pr (view|diff|checks|review)\b|\bgit log -p\b/i

const SETUP = /^(cd|set-location|sl|pushd|popd|export|set|setx)$/i
const KNOWN_SUBCOMMANDS = /^(git|gh|npm|pnpm|yarn|dotnet|cargo|go|docker|kubectl|az|aws)$/i
const CLAUDE_SUBCOMMANDS = /^(plugin|mcp|config|update|doctor|install|migrate-installer|setup-token)$/i

const SECRET_PREFIX = /^(gh[pousr]_|github_pat_|glpat-|sk-|sk_|pk_|rk_|xox[a-z]-|AKIA|ASIA|AIza|ya29\.|eyJ)/i

/**
 * The last part of a Windows or POSIX path.
 * @param {string} path
 * @returns {string}
 */
export function basename(path) {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? path
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function looksLikeSecret(name) {
  if (SECRET_PREFIX.test(name) || /^[0-9a-f]{16,}$/i.test(name)) return true
  return name.length >= 20 && /\d/.test(name) && /[a-z]/i.test(name) && !/[.\-]/.test(name)
}

/**
 * @param {string} command
 * @returns {{ text: string, isQuoted: boolean }[][]}
 */
function segmentsOf(command) {
  /** @type {{ text: string, isQuoted: boolean }[][]} */
  const segments = [[]]
  let token = ''
  let isQuoted = false
  let quote = ''
  const endToken = () => {
    if (token !== '' || isQuoted) segments[segments.length - 1]?.push({ text: token, isQuoted })
    token = ''
    isQuoted = false
  }
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i)
    if (quote) {
      if (ch === quote) quote = ''
      else token += ch
    } else if (ch === '"' || ch === "'") {
      if (token === '') isQuoted = true
      quote = ch
    } else if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r' || (ch === '&' && command.charAt(i + 1) === '&')) {
      endToken()
      segments.push([])
      if ((ch === '|' || ch === '&') && command.charAt(i + 1) === ch) i += 1
    } else if (/\s/.test(ch)) endToken()
    else token += ch
  }
  endToken()
  return segments
}

/**
 * The program a command runs, and for a few tools its subcommand: never an
 * argument, an assignment, a variable or a quoted string. Anything that does
 * not look like a plain program name (a quoted path, a token-shaped word) is
 * published as `shell`.
 * @param {string} command
 * @returns {string}
 */
export function commandHead(command) {
  for (const tokens of segmentsOf(command)) {
    while (tokens.length > 0 && !tokens[0]?.isQuoted && (/^[A-Za-z_]\w*=/.test(tokens[0]?.text ?? '') || tokens[0]?.text === '&')) {
      const substituted = /^[A-Za-z_]\w*=(?:\$\(|`)(.+)$/.exec(tokens[0]?.text ?? '')
      if (substituted?.[1]) {
        tokens[0] = { text: substituted[1].replace(/[)`]+$/, ''), isQuoted: false }
        break
      }
      tokens.shift()
    }
    const first = tokens[0]
    if (!first) continue
    if (first.isQuoted) return 'shell'
    if (first.text.startsWith('$') || first.text.startsWith('-') || first.text.includes('=') || SETUP.test(first.text)) continue
    const program = basename(first.text.replace(/^\.+(?=[\\/])/, '')).replace(/\.(exe|cmd|bat|ps1)$/i, '')
    if (!/^[\w.-]{1,40}$/.test(program) || looksLikeSecret(program)) return 'shell'
    const sub = tokens[1]
    const subText = sub && !sub.isQuoted && !looksLikeSecret(sub.text) ? sub.text : ''
    if (KNOWN_SUBCOMMANDS.test(program) && /^[a-z][\w-]{0,30}$/i.test(subText)) return `${program} ${subText}`
    if (/^claude$/i.test(program) && CLAUDE_SUBCOMMANDS.test(subText)) return `${program} ${subText}`
    return program
  }
  return 'shell'
}

/**
 * @param {string} command
 * @returns {{ category: ToolCategory, target: string }}
 */
export function categorizeCommand(command) {
  const target = commandHead(command)
  if (TEST_RUNNER.test(command)) return { category: 'test', target }
  if (MERGE.test(command)) return { category: 'merge', target }
  if (GIT_WRITE.test(command)) return { category: 'git-write', target }
  if (REVIEW.test(command)) return { category: 'review', target }
  return { category: 'shell', target }
}

/**
 * @param {Record<string, unknown>} input
 * @param {string} name
 * @returns {string}
 */
function field(input, name) {
  const value = input[name]
  return typeof value === 'string' ? value : ''
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return 'web'
  }
}

/**
 * A tool call reduced to what Orbit may show: its category and a safe target
 * (file basename, program name, hostname), never its arguments or output.
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @returns {{ category: ToolCategory, target: string }}
 */
export function categorizeTool(tool, input) {
  switch (tool) {
    case 'Read':
    case 'NotebookRead':
      return { category: 'read', target: basename(field(input, 'file_path') || field(input, 'notebook_path')) }
    case 'Grep':
    case 'Glob':
    case 'LS':
      return { category: 'search', target: basename(field(input, 'path')).slice(0, 40) || (tool === 'Grep' ? 'code' : 'files') }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { category: 'edit', target: basename(field(input, 'file_path') || field(input, 'notebook_path')) }
    case 'Bash':
    case 'PowerShell':
      return categorizeCommand(field(input, 'command'))
    case 'WebFetch':
      return { category: 'web', target: hostOf(field(input, 'url')) }
    case 'WebSearch':
      return { category: 'web', target: 'web search' }
    case 'Agent':
    case 'Task': {
      const description = field(input, 'description')
      const type = field(input, 'subagent_type')
      return {
        category: /review/i.test(`${description} ${type}`) ? 'review' : 'agent',
        target: (description || type || 'subagent').slice(0, 60),
      }
    }
    case 'AskUserQuestion':
      return { category: 'question', target: 'asked you a question' }
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return { category: 'plan', target: tool === 'ExitPlanMode' ? 'presented a plan' : 'entered plan mode' }
    case 'Skill': {
      const skill = field(input, 'skill') || field(input, 'name') || 'skill'
      return { category: /review/i.test(skill) ? 'review' : 'skill', target: skill.slice(0, 40) }
    }
    default:
      if (tool.startsWith('mcp__')) {
        const [, server = '', name = ''] = tool.split('__')
        return { category: 'mcp', target: `${server}/${name}`.slice(0, 50) }
      }
      return { category: 'other', target: tool.slice(0, 40) }
  }
}
