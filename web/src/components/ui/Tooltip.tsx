import { useEffect, useRef, useState } from 'react'

/**
 * One tooltip for the whole app: any element with `data-tip` gets a styled tooltip on hover or keyboard
 * focus (not on mouse focus). The first one waits a moment; while one was just visible, the next shows at
 * once, so scanning a toolbar is fast. Lives in the top layer, so it also works inside dialogs.
 */
const MUTATING = '.btn-primary, .composer-send, [data-mutates]' // same as App: blocked while offline
const offline = () => document.querySelector('.app')?.getAttribute('data-conn') === 'closed'

export function TooltipLayer() {
  const ref = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ text: string; el: HTMLElement } | null>(null)

  useEffect(() => {
    let timer = 0
    let lastHidden = 0
    let current: HTMLElement | null = null
    const show = (el: HTMLElement) => {
      const text = offline() && el.matches(MUTATING) ? 'Нет связи с сервером' : el.dataset.tip
      if (!text || el === current) return
      // Rows and titles: a tooltip only when the visible label is actually truncated, and a bit later.
      const trunc = el.hasAttribute('data-tip-trunc')
      if (trunc) {
        const label = el.matches('.label, .ellipsis, .tab-title') ? el : el.querySelector<HTMLElement>('.label, .ellipsis, .tab-title')
        if (!label || label.scrollWidth <= label.clientWidth) return
      }
      current = el
      window.clearTimeout(timer)
      const warm = Date.now() - lastHidden < 400
      timer = window.setTimeout(() => setTip({ text, el }), warm ? 0 : trunc ? 600 : 450)
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
      if (el) show(el)
      else if (current) hide()
    }
    const focus = (e: FocusEvent) => {
      const el = (e.target as Element).closest?.<HTMLElement>('[data-tip]')
      if (el && el.matches(':focus-visible')) show(el)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', hide)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerdown', hide, true)
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
