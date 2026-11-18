import { useEffect, useRef, useState } from 'react'

/**
 * One tooltip for the whole app. Keyboard focus (focus-visible) shows any `data-tip`. The mouse is kept quiet on
 * purpose (users found hover tips in the way everywhere): only icon-only buttons outside lists get one, after a
 * deliberate ~1 s hover; rows, file names, tabs, cards, the sidebar and the side panel never pop anything up.
 * Lives in the top layer, so it also works inside dialogs.
 */
const QUIET = '.sidebar, .wpanel, [role="tablist"], [role="tree"], [role="listbox"], [data-tip-quiet]'
const iconOnly = (el: HTMLElement) => !el.textContent?.trim()
const MUTATING = '.btn-primary, .composer-send, [data-mutates]' // same as App: blocked while offline
const offline = () => document.querySelector('.app')?.getAttribute('data-conn') === 'closed'

export function TooltipLayer() {
  const ref = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ text: string; el: HTMLElement } | null>(null)

  useEffect(() => {
    let timer = 0
    let lastHidden = 0
    let current: HTMLElement | null = null
    let pressed: HTMLElement | null = null
    const show = (el: HTMLElement, pointer = false) => {
      const blocked = offline() && el.matches(MUTATING)
      const text = blocked ? 'Нет связи с сервером' : el.dataset.tip
      if (!text || el === current || el === pressed) return
      // mouse: only icon-only buttons outside lists (and the offline reason on a blocked action)
      if (pointer && !blocked && (el.hasAttribute('data-tip-trunc') || !iconOnly(el) || el.closest(QUIET))) return
      // Rows and titles: a tooltip only when the visible label is actually truncated, and a bit later.
      const trunc = el.hasAttribute('data-tip-trunc')
      if (trunc) {
        const label = el.matches('.label, .ellipsis, .tab-title') ? el : el.querySelector<HTMLElement>('.label, .ellipsis, .tab-title')
        if (!label || label.scrollWidth <= label.clientWidth) return
      }
      current = el
      window.clearTimeout(timer)
      const warm = Date.now() - lastHidden < 400
      timer = window.setTimeout(() => setTip({ text, el }), pointer ? (warm ? 150 : 1000) : warm ? 0 : 450)
    }
    const hide = () => {
      window.clearTimeout(timer)
      if (current) lastHidden = Date.now()
      current = null
      setTip(null)
    }
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const el = (e.target as Element).closest<HTMLElement>(offline() ? `${MUTATING}, [data-tip]` : '[data-tip]')
      if (pressed && el !== pressed) pressed = null // left what was clicked: its tooltip may come back next time
      if (el) show(el, true)
      else if (current) hide()
    }
    const focus = (e: FocusEvent) => {
      const el = (e.target as Element).closest?.<HTMLElement>('[data-tip]')
      if (el && el.matches(':focus-visible')) show(el)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    document.addEventListener('pointerover', over)
    // a click hides the tooltip, and it stays hidden while the pointer is still on what was clicked
    const down = (e: PointerEvent) => { pressed = (e.target as Element).closest?.<HTMLElement>('[data-tip]') ?? null; hide() }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', hide)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('focusin', focus)
      document.removeEventListener('focusout', hide)
      document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', hide, true)
    }
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!tip || !el) return
    if (!tip.el.isConnected) { setTip(null); return }
    try { el.showPopover() } catch { /* unsupported: inline */ }
    const r = tip.el.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const above = r.top - h - 6 >= 4
    el.style.top = `${above ? r.top - h - 6 : r.bottom + 6}px`
    el.style.left = `${Math.min(Math.max(4, r.left + r.width / 2 - w / 2), window.innerWidth - w - 4)}px`
    el.dataset.side = above ? 'top' : 'bottom'
    return () => { try { el.hidePopover() } catch { /* not shown */ } }
  }, [tip])

  if (!tip) return null
  return <div ref={ref} popover="manual" role="tooltip" className="tooltip">{tip.text}</div>
}
