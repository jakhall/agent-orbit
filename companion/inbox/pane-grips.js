import { $, remember, stored } from './page-state.js'

const STEP_PX = 20
const STAGE_MIN_PX = 320
const PANES = [
  { grip: 'cx-rail-grip', pane: 'cx-rail', prop: '--rail-w', key: 'railWidth', min: 180, max: 480, grows: 'ArrowRight' },
  { grip: 'cx-panel-grip', pane: 'cx-panel', prop: '--panel-w', key: 'panelWidth', min: 300, max: 900, grows: 'ArrowLeft' },
]

/** The grips on the rail's and the panel's inner edges: drag, or ← → on one, sets that pane's width (kept per window); double-click resets it. */
export function bindPaneGrips() {
  const body = document.querySelector('.cx-body')
  if (!(body instanceof HTMLElement)) return
  for (const spec of PANES) {
    const grip = $(spec.grip)
    if (grip) bindGrip(body, grip, spec, PANES.find(other => other !== spec))
  }
}

function bindGrip(body, grip, spec, other) {
  const widthOf = id => {
    const node = $(id)
    if (!node || node.hidden || node.offsetParent === null) return 0
    return id === 'cx-rail' ? parseFloat(getComputedStyle(body).gridTemplateColumns) || 0 : node.getBoundingClientRect().width
  }
  const clamp = width => {
    const room = body.getBoundingClientRect().width - widthOf(other.pane) - STAGE_MIN_PX
    return Math.round(Math.max(spec.min, Math.min(spec.max, room, width)))
  }
  const show = width => {
    grip.setAttribute('aria-valuemin', String(spec.min))
    grip.setAttribute('aria-valuemax', String(spec.max))
    grip.setAttribute('aria-valuenow', String(Math.round(width)))
  }
  const apply = (width, persist) => {
    const next = clamp(width)
    body.style.setProperty(spec.prop, `${next}px`)
    show(next)
    if (persist) remember(spec.key, next)
  }
  const widthAt = clientX => {
    const box = body.getBoundingClientRect()
    return spec.pane === 'cx-rail' ? clientX - box.left : box.right - clientX
  }
  grip.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    event.preventDefault()
    grip.setPointerCapture(event.pointerId)
    grip.classList.add('active')
    body.classList.add('is-resizing')
    const move = e => apply(widthAt(e.clientX), false)
    const end = e => {
      grip.removeEventListener('pointermove', move)
      grip.classList.remove('active')
      body.classList.remove('is-resizing')
      apply(widthAt(e.clientX), true)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', end, { once: true })
    grip.addEventListener('pointercancel', end, { once: true })
  })
  grip.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    apply(widthOf(spec.pane) + (event.key === spec.grows ? STEP_PX : -STEP_PX), true)
  })
  grip.addEventListener('dblclick', () => {
    body.style.removeProperty(spec.prop)
    remember(spec.key, null)
    show(widthOf(spec.pane))
  })
  const saved = Number(stored(spec.key, null))
  if (saved > 0) apply(saved, false)
  else show(widthOf(spec.pane))
}
