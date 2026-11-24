import { descendantsOf } from '/shared/filters.js'
import { mapClickAction } from '/shared/popout.js'
import { hitTest, offsetFor } from '/shared/render.js'
import { $, CLICK_SLOP_PX, HIT_SLACK_PX, state, TOUCH_SLOP_PX, view, ZOOM_STEP } from './page-state.js'
import { load } from './live.js'
import { renderRail } from './rail.js'
import { patchPrefs, repositionMap } from './actions.js'
import { animateTo, cameraGoal, fitAndRender, invalidateGeometry, minimapModel, moveCamera, renderMap, settleAnimation, settleTimer, stageBox, toWorld, zoomAt } from './stage.js'
import { cardTimer, hideCard, scheduleCard } from './card.js'
import { closePanel, focusProject, select, selectAgent } from './panel.js'

export function bindStage() {
  const stage = $('cx-stage')
  let drag = null
  stage.addEventListener(
    'wheel',
    event => {
      if (!state.camera) return
      event.preventDefault()
      settleAnimation()
      zoomAt(event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, toWorld(event.clientX, event.clientY))
    },
    { passive: false },
  )
  stage.addEventListener('pointerdown', event => {
    if (!state.camera || event.button !== 0 || event.target.closest?.('button')) return
    const nodeId = event.target instanceof Element ? event.target.closest('g.n')?.getAttribute('data-id') : null
    const node = nodeId ? state.visible?.nodes.find(n => n.id === nodeId) : null
    if (node) {
      settleAnimation()
      hideCard()
    }
    if (event.pointerType === 'mouse') window.getSelection()?.removeAllRanges()
    drag = { x: event.clientX, y: event.clientY, camera: state.camera, moved: false, slop: event.pointerType === 'touch' ? TOUCH_SLOP_PX : CLICK_SLOP_PX, node: node ?? null, group: node ? descendantsOf(node.id, state.visible.nodes) : null, handle: null }
    stage.setPointerCapture(event.pointerId)
  })
  stage.addEventListener('pointermove', event => {
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (Math.hypot(dx, dy) > drag.slop && !drag.moved) {
      drag.moved = true
      stage.classList.add('is-dragging')
      hideCard()
      if (drag.node) {
        if (drag.node.kind === 'project' && state.selected !== drag.node.id) focusProject(drag.node.id)
        state.nodeDrag = true
        drag.handle = view.beginMove(drag.group, new Map(state.visible.nodes.map(n => [n.id, n])))
      }
    }
    if (!drag.moved) return
    const perPx = drag.camera.w / stageBox().width
    if (drag.node) {
      drag.delta = { x: dx * perPx, y: dy * perPx }
      if (drag.frame) return
      drag.frame = requestAnimationFrame(() => {
        if (!drag?.node) return
        drag.frame = 0
        view.moveGroup(drag.handle, drag.delta.x, drag.delta.y)
      })
      return
    }
    moveCamera({ ...drag.camera, x: drag.camera.x - dx * perPx, y: drag.camera.y - dy * perPx })
  })
  stage.addEventListener('pointerup', event => {
    if (!drag) return
    const d = drag
    drag = null
    stage.classList.remove('is-dragging')
    if (d.frame) cancelAnimationFrame(d.frame)
    if (d.moved && d.node) {
      const perPx = d.camera.w / stageBox().width
      const delta = { x: (event.clientX - d.x) * perPx, y: (event.clientY - d.y) * perPx }
      view.moveGroup(d.handle, delta.x, delta.y)
      void saveDrag(d.node, d.handle, delta)
      return
    }
    if (d.moved) {
      clearTimeout(settleTimer)
      renderMap()
      return
    }
    if (!state.visible) return
    const at = toWorld(event.clientX, event.clientY)
    const labelled = event.target instanceof Element ? event.target.closest('g.k-session')?.getAttribute('data-id') : null
    const sessionHit = labelled ? { id: labelled } : hitTest(state.visible.nodes.filter(n => n.kind === 'session'), at.x, at.y, HIT_SLACK_PX * at.perPx)
    const hitId = d.node?.id?.startsWith('a:') ? d.node.id : (sessionHit?.id ?? d.node?.id ?? null)
    const action = mapClickAction(hitId)
    if (action === 'select') select(hitId.slice(2), stage)
    else if (action === 'agent') selectAgent(hitId.slice(2), stage)
    else if (action === 'project') focusProject(hitId, { open: true, invoker: stage })
    else if (action === 'deselect') deselectMap()
  })
  stage.addEventListener('pointercancel', () => {
    if (!drag) return
    const d = drag
    drag = null
    stage.classList.remove('is-dragging')
    if (d.handle) view.endMove(d.handle)
    state.nodeDrag = false
    renderMap()
  })
  stage.addEventListener('pointermove', event => {
    if (event.buttons || !state.visible || !state.camera) return
    const at = toWorld(event.clientX, event.clientY)
    const labelled = event.target instanceof Element ? event.target.closest('g.k-session')?.getAttribute('data-id') : null
    const hit = labelled ? { id: labelled } : hitTest(state.visible.nodes.filter(n => n.kind === 'session'), at.x, at.y, HIT_SLACK_PX * at.perPx)
    scheduleCard(hit?.id?.startsWith('s:') ? hit.id.slice(2) : null)
  })
  stage.addEventListener('pointerleave', event => {
    if (!$('cx-card').contains(event.relatedTarget)) scheduleCard(null)
  })
  $('cx-card').addEventListener('pointerenter', () => clearTimeout(cardTimer))
  $('cx-card').addEventListener('pointerleave', event => {
    if (!stage.contains(event.relatedTarget)) scheduleCard(null)
  })
  $('cx-zoom-in').addEventListener('click', () => zoomAt(1 / ZOOM_STEP))
  $('cx-zoom-out').addEventListener('click', () => zoomAt(ZOOM_STEP))
  $('cx-fit').addEventListener('click', fitAndRender)
  $('cx-reposition').addEventListener('click', () => void repositionMap())
  window.addEventListener('resize', () => {
    invalidateGeometry()
    renderMap()
  })
  $('cx-minimap').addEventListener('click', event => {
    if (!minimapModel || !state.camera) return
    const r = $('cx-minimap').getBoundingClientRect()
    const at = minimapModel.toWorld(((event.clientX - r.left) / r.width) * 160, ((event.clientY - r.top) / r.height) * 96)
    state.isMoved = true
    const goal = cameraGoal()
    animateTo({ ...goal, x: at.x - goal.w / 2, y: at.y - goal.h / 2 })
  })
}

/** Saves a dragged node where it was dropped (1.15: `prefs.positions`, a hub at its place, anything else relative to its parent) and lays the map out again; on a failed save it goes back. */
async function saveDrag(node, handle, delta) {
  const graph = state.snapshot?.graph.nodes ?? []
  const laid = graph.find(n => n.id === node.id) ?? node
  const offset = offsetFor(laid, laid.x + delta.x, laid.y + delta.y, graph)
  const saved = await patchPrefs({ positions: { [node.id]: offset } })
  view.endMove(handle)
  state.nodeDrag = false
  if (!saved) return renderMap()
  state.layoutKey = null
  await load()
}

/** A click on empty map: nothing is selected any more and the panel closes, as in 1.15. */
function deselectMap() {
  hideCard()
  if (!$('cx-panel').hidden) {
    closePanel()
    $('cx-stage').focus({ preventScroll: true })
    return
  }
  if (!state.selected && !state.focusNode) return
  state.selected = null
  state.focusNode = null
  renderRail()
  renderMap()
}
