import { escapeAction, statusOf } from '/shared/popout.js'
import { bucketOf } from '/shared/map.js'
import { hooks } from './ctx.js'
import { stickChat } from './chat.js'
import { initSheets, isDialogOpen, openNewSession, openPalette, openSettings } from './sheets.js'
import { $, HEALTH_EVERY_MS, state, view, visibleSessions, WANTS_METRICS } from './page-state.js'
import { connect, isArmed, load, loadArm, pollHealth, reportAttention } from './live.js'
import { bindChrome, narrowHeader, placeholderFits, renderAll, renderHeader, usageView } from './header.js'
import { railParts, setRailOpen } from './rail.js'
import { openInClaude, paletteActions, patchPrefs, runAction } from './actions.js'
import { armToast, closeToast, homeFocus, toast, toastTimer } from './toast.js'
import { invalidateGeometry, renderMap } from './stage.js'
import { bindStage } from './stage-input.js'
import { bindPaneGrips } from './pane-grips.js'
import { hideCard } from './card.js'
import { noteFocus, onKey, railOrder, runSearch } from './keys.js'
import { closePanel, focusOpenTitle, isProjectPanelOpen, renderPanel, select, setDetailsOpen } from './panel.js'
import { bench, metrics } from './metrics.js'
import { MOD_VERSION } from '/shared/constants.js'
import { bindSound } from './notify.js'

history.replaceState(null, '', '/inbox')

function boot() {
  if (WANTS_METRICS) {
    window.orbitMetrics = metrics
    window.orbitBench = bench
    window.orbitView = view
  }
  bindStage()
  $('cx-version').textContent = `v${MOD_VERSION}`
  $('cx-version').title = `Orbit ${MOD_VERSION}`
  bindPaneGrips()
  document.addEventListener('keydown', event => {
    if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
    event.preventDefault()
    if (!isDialogOpen()) openPalette()
  })
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || isDialogOpen()) return
    const active = document.activeElement
    const cardShown = !$('cx-card').hidden && Boolean(state.cardKey) && $('cx-card').getBoundingClientRect().width > 0
    const step = escapeAction({
      inPanelField: active instanceof HTMLElement && active !== $('cx-search') && Boolean(active.closest('#cx-panel, #cx-convo')) && active.matches('input, textarea, select'),
      inSearch: document.activeElement === $('cx-search'),
      hasQuery: Boolean(state.query),
      railOpen: document.querySelector('.cx-body').classList.contains('is-rail-open'),
      cardShown,
      panelOpen: Boolean(state.convo.key) || isProjectPanelOpen(),
      detailsShown: document.querySelector('.cx-body').classList.contains('is-details-open'),
      projectFocused: state.selected?.startsWith('p:') === true,
    })
    if (step.blurField) {
      const cardTitle = active.closest('.approval')?.querySelector('.h-title')
      if (cardTitle instanceof HTMLElement) cardTitle.focus({ preventScroll: true })
      else focusOpenTitle()
    } else if (step.clearSearch) {
      $('cx-search').value = ''
      runSearch('')
    } else if (step.closeRail) {
      setRailOpen(false)
      ;(railParts.opener?.isConnected ? railParts.opener : railParts.strip?.querySelector('.cx-strip-toggle'))?.focus({ preventScroll: true })
    } else if (step.closeDetails) {
      setDetailsOpen(false)
    } else if (step.closePanel) {
      if (step.hideCard) hideCard()
      closePanel()
    } else if (step.hideCard) {
      const wasInCard = $('cx-card').contains(document.activeElement)
      hideCard()
      state.focusNode = null
      renderMap()
      if (wasInCard) homeFocus().focus({ preventScroll: true })
    } else if (step.clearFocus) {
      state.selected = null
      renderMap()
    }
  })
  document.addEventListener('keydown', onKey)
  document.addEventListener('focusin', noteFocus)
  document.addEventListener('keydown', noteFocus, true)
  document.addEventListener('click', noteFocus, true)
  $('cx-rail').addEventListener('focusout', event => {
    if (!document.querySelector('.cx-body').classList.contains('is-rail-open')) return
    if (event.relatedTarget instanceof Node && !$('cx-rail').contains(event.relatedTarget)) setRailOpen(false)
  })
  document.addEventListener('pointerdown', event => {
    if (!document.querySelector('.cx-body').classList.contains('is-rail-open')) return
    if (event.target instanceof Element && event.target.closest('#cx-rail')) return
    setRailOpen(false)
  })
  $('cx-toast').addEventListener('pointerenter', () => clearTimeout(toastTimer))
  $('cx-toast').addEventListener('pointerleave', () => !$('cx-toast').hidden && !$('cx-toast').contains(document.activeElement) && armToast())
  $('cx-toast').addEventListener('focusin', () => clearTimeout(toastTimer))
  $('cx-toast').addEventListener('focusout', event => !$('cx-toast').contains(event.relatedTarget) && !$('cx-toast').hidden && armToast())
  $('cx-search').addEventListener('input', () => runSearch($('cx-search').value))
  $('cx-search').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    const first = railOrder().find(key => state.matches.has(key))
    if (first) select(first, $('cx-search'))
  })
  hooks.rerender = () => renderPanel()
  hooks.status = (text, isBad = false, action = null) => (text ? toast(text, null, action) : closeToast())
  hooks.isArmed = isArmed
  hooks.openSession = s => void openInClaude(s.key)
  hooks.wakeSession = s => openInClaude(s.key, { quiet: true })
  hooks.select = key => select(key)
  hooks.showSwitches = () => openSettings('cx-s-arm-replies')
  initSheets({
    prefs: () => state.prefs,
    arm: () => state.arm,
    snapshot: () => state.snapshot,
    lookup: () => state.lookup,
    attention: () => state.visible?.attention ?? [],
    listed: () => visibleSessions().map(s => s.key),
    bucketOf,
    actions: paletteActions,
    runAction,
    reasonOf: s => statusOf(s).reason,
    limits: usageView,
    projectOptions: () => state.visible?.projectOptions ?? [],
    select: key => select(key),
    openInClaude: key => void openInClaude(key),
    unhide: key => patchPrefs({ hidden: Object.fromEntries(Object.entries(state.prefs?.hidden ?? {}).filter(([k]) => k !== key)) }),
    toast: (text, action = null, sessionKey = null) => toast(text, null, action, sessionKey),
    patchPrefs,
    reloadArm: loadArm,
    rerender: () => renderPanel(),
  })
  $('cx-new-open').addEventListener('click', () => openNewSession())
  $('cx-settings-open').addEventListener('click', () => openSettings($('cx-settings-open').dataset.armedFocus || null))
  bindChrome()
  hooks.onClosed = () => (state.isClosed = true)
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel']) document.addEventListener(type, () => (state.lastInputAt = Date.now()), { passive: true, capture: true })
  bindSound()
  document.addEventListener('visibilitychange', reportAttention)
  window.addEventListener('focus', reportAttention)
  window.addEventListener('blur', reportAttention)
  setInterval(reportAttention, 10_000)
  window.addEventListener('resize', () => stickChat())
  window.addEventListener('resize', invalidateGeometry)
  if (typeof ResizeObserver === 'function') {
    const watch = new ResizeObserver(() => {
      invalidateGeometry()
      if (state.snapshot) renderMap()
    })
    for (const node of [$('cx-stage'), $('cx-panel'), document.querySelector('.cx-camera')]) if (node) watch.observe(node)
  }
  narrowHeader.addEventListener('change', placeholderFits)
  window.addEventListener('resize', placeholderFits)
  placeholderFits()
  $('cx-limits').addEventListener('click', () => openSettings('cx-s-usage'))
  window.addEventListener('storage', event => {
    if (event.key !== 'orbit.theme') return
    let choice = null
    try {
      choice = JSON.parse(event.newValue ?? 'null')
    } catch {}
    if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice
    else delete document.documentElement.dataset.theme
  })
  renderAll()
  connect()
  void load()
  void pollHealth()
  setInterval(pollHealth, HEALTH_EVERY_MS)
  setInterval(renderHeader, 1_000)
}

boot()
