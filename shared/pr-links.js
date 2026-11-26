// @ts-check

import { normalizeFolder } from './links.js'

/** @typedef {import('../types').Snapshot} Snapshot */
/** @typedef {import('../types').PullRequestView} PullRequestView */
/** @typedef {import('../types').PrStatus} PrStatus */
/** @typedef {{ url: string, number: number, repo: string, branch: string | null, state: string, isSessions: boolean }} PrChoice */

const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/
export const PR_CHOICES_MAX = 20

/**
 * Whether `url` is a plain GitHub pull request link, the only form that may
 * reach `gh` or a skill line (no query, fragment, credentials or other host).
 * @param {unknown} url
 * @returns {url is string}
 */
export function isPrUrl(url) {
  return typeof url === 'string' && url.length <= 300 && PR_URL.test(url) && !/\/\.{1,2}\//.test(url)
}

/**
 * A pasted pull request link in the plain form `isPrUrl` accepts (a trailing
 * slash, query, fragment or tab such as `/files` dropped), or null.
 * @param {unknown} text
 * @returns {string | null}
 */
export function prLinkOf(text) {
  if (typeof text !== 'string') return null
  const url = text
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/(files|commits|checks|changes)(\/.*)?$/, '')
    .replace(/\/+$/, '')
  return isPrUrl(url) ? url : null
}

/**
 * The pull requests to offer when applying a skill: those `sessionKey` links
 * first, then those linked from other sessions of the same project (or
 * started in `folder`) or naming the same repository, newest session first,
 * one per URL. Links Claude desktop dismissed are left out.
 * @param {Snapshot | null | undefined} snapshot
 * @param {{ sessionKey?: string | null, folder?: string | null }} where
 * @returns {PrChoice[]}
 */
export function prChoices(snapshot, where) {
  const sessions = [...(snapshot?.sessions ?? [])].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
  const own = where.sessionKey ? sessions.find(s => s.key === where.sessionKey) : undefined
  const folderKey = (/** @type {string | null | undefined} */ f) => (f ? (normalizeFolder(f) ?? '').toLowerCase() : '')
  const folder = folderKey(where.folder)
  const projects = new Set(own ? [own.projectId] : [])
  if (folder) {
    for (const p of snapshot?.projects ?? []) if (folderKey(p.root) === folder) projects.add(p.id)
    for (const s of sessions) if (folderKey(s.cwd) === folder) projects.add(s.projectId)
  }
  const related = sessions.filter(s => projects.has(s.projectId))
  const repos = new Set(related.flatMap(s => (s.prs ?? []).map(pr => pr.repo)).filter(Boolean))
  /** @type {PrChoice[]} */
  const out = []
  const add = (/** @type {PullRequestView} */ pr, /** @type {boolean} */ isSessions) => {
    if (pr.dismissed || !isPrUrl(pr.url) || out.some(c => c.url === pr.url)) return
    out.push({ url: pr.url, number: pr.number, repo: pr.repo, branch: pr.branch ?? null, state: pr.state, isSessions })
  }
  for (const pr of own?.prs ?? []) add(pr, true)
  for (const s of sessions) {
    if (s === own) continue
    const isRelated = projects.has(s.projectId)
    for (const pr of s.prs ?? []) if (isRelated || repos.has(pr.repo)) add(pr, false)
  }
  return out.slice(0, PR_CHOICES_MAX)
}

/**
 * What the Pull request field holds: '' when empty, the PR link it names
 * (a pasted link, or `42` / `#42` for an offered choice), or null when it
 * names none.
 * @param {unknown} text
 * @param {PrChoice[]} choices
 * @returns {string | null}
 */
export function prFromInput(text, choices) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value === '') return ''
  const number = /^#?(\d{1,9})$/.exec(value)
  if (number) return choices.find(c => c.number === Number(number[1]))?.url ?? null
  return prLinkOf(value)
}

/**
 * An offered PR's first line: its title from `gh`, else its branch, else
 * `acme/app #42`.
 * @param {PrChoice} choice
 * @param {PrStatus | null | undefined} status
 * @returns {string}
 */
export function prChoiceTitle(choice, status) {
  return status?.title || choice.branch || `${choice.repo} #${choice.number}`
}

/**
 * An offered PR's second line: `acme/app #42 · open · checks passing · my-branch`
 * (the branch only when the title is shown above it).
 * @param {PrChoice} choice
 * @param {PrStatus | null | undefined} status
 * @returns {string}
 */
export function prChoiceDetail(choice, status) {
  const desktopState = choice.state && choice.state !== 'UNKNOWN' ? choice.state.toLowerCase() : ''
  const checks = { failing: 'checks failing', pending: 'checks running', passing: 'checks passing', none: '' }
  const review = { approved: 'approved', changes: 'changes requested', required: '' }
  const isOpen = !status || status.state === 'open' || status.state === 'draft'
  const words = [
    `${choice.repo} #${choice.number}`,
    status?.state ?? desktopState,
    isOpen && status ? checks[status.checks] : '',
    isOpen && status?.review ? review[status.review] : '',
    status?.title && choice.branch ? choice.branch : '',
  ]
  return words.filter(Boolean).join(' · ')
}

/**
 * The offered PRs whose title, branch, repository or number hold every word
 * of `text` (any case); all of them for empty text or a pasted link.
 * @param {PrChoice[]} choices
 * @param {string} text
 * @param {Readonly<Record<string, PrStatus>> | null | undefined} statuses by PR URL
 * @returns {PrChoice[]}
 */
export function filterPrChoices(choices, text, statuses) {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0 || /^https?:\/\//i.test(text.trim())) return choices
  return choices.filter(c => {
    const status = statuses && Object.hasOwn(statuses, c.url) ? statuses[c.url] : null
    const haystack = `${status?.title ?? ''} ${c.branch ?? ''} ${c.repo} #${c.number}`.toLowerCase()
    return words.every(w => haystack.includes(w))
  })
}
