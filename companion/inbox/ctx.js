/**
 * What the panel's chat, composer and request card share with the page:
 * DOM helpers, the API, their own state, and the page's hooks (set by
 * main.js at boot).
 */

export const $ = id => document.getElementById(id)

export const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.className = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : String(v))
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child)
  return node
}

export const state = {
  selected: null,
  lookup: null,
  shell: null,
  showConvo: true,
  convo: new Map(),
  send: null,
  drafts: new Map(),
  approvals: [],
  approvalsEnabled: false,
  approvalOutcomes: new Map(),
}

export const hooks = {
  rerender: () => {},
  status: (_text, _isBad = false, _action = null) => {},
  isArmed: _capability => false,
  openSession: _s => {},
  /** @type {(s: any) => Promise<string | null | undefined>} opens the session in Claude desktop; the failure in words, or nothing */
  wakeSession: async _s => null,
  select: _key => {},
  showSwitches: () => {},
  onClosed: () => {},
}

export async function api(method, route, body, signal) {
  const res = await fetch(route, { method, signal, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (res.status === 403) hooks.onClosed()
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw Object.assign(new Error(detail?.error ?? `${route}: ${res.status}`), { status: res.status, detail })
  }
  return res.json()
}

export function selectedSession() {
  return state.selected?.startsWith('s:') && state.lookup ? (state.lookup.sessions.get(state.selected.slice(2)) ?? null) : null
}

/** Puts `nodes` into `parent`, keeping nodes already there in place, so focus and caret survive a redraw. */
export function patchChildren(parent, nodes) {
  const current = [...parent.childNodes]
  if (nodes.some((node, i) => node.parentNode === parent && current[i] !== node)) return parent.replaceChildren(...nodes)
  nodes.forEach((node, i) => {
    const old = current[i]
    if (old === node) return
    if (old?.nodeType === 1 && node.nodeType === 1 && old.outerHTML === node.outerHTML) return
    if (old) old.replaceWith(node)
    else parent.append(node)
  })
  for (const old of current.slice(nodes.length)) old.remove()
}

/** Says `text` in the panel's live region, after clearing it, so a repeat is announced too. */
export function announce(text, isBad = false) {
  const region = $(isBad ? 'cx-send-alert' : 'cx-send-live')
  if (!region) return
  region.textContent = ''
  setTimeout(() => (region.textContent = text), 50)
}
