import { useEffect, useRef, useState } from 'react'

// Prefer the control's own description over a tooltip belonging to its parent row.
const TARGET = '[data-tip], button, [role="button"], [role="tab"], [role="combobox"]'
const MUTATING = '.btn-primary, .composer-send, [data-mutates]' // same as App: blocked while offline
const offline = () => document.querySelector('.app')?.getAttribute('data-conn') === 'closed'

export function TooltipLayer() {
  const ref = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ text: string; el: HTMLElement } | null>(null)

  useEffect(() => {
    let timer = 0
    let current: HTMLElement | null = null
    let pressed: HTMLElement | null = null
    const show = (el: HTMLElement, pointer = false) => {
      const blocked = offline() && el.matches(MUTATING)
      if (el === current || el === pressed) return
      hide()
      const text = blocked ? 'Нет связи с сервером' : el.dataset.tip || (!el.textContent?.trim() && el.getAttribute('aria-label'))
      if (!text) return
      const trunc = el.hasAttribute('data-tip-trunc')
      if (trunc) {
        const label = el.matches('.label, .ellipsis, .tab-title') ? el : el.querySelector<HTMLElement>('.label, .ellipsis, .tab-title')
        if (!label || label.scrollWidth <= label.clientWidth) return
      }
      current = el
      timer = window.setTimeout(() => { if (el.isConnected) setTip({ text, el }) }, pointer ? 800 : 350)
    }
    const hide = () => {
      window.clearTimeout(timer)
      current = null
      setTip(null)
    }
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const el = (e.target as Element).closest<HTMLElement>(offline() ? `${MUTATING}, ${TARGET}` : TARGET)
      if (pressed && el !== pressed) pressed = null // left what was clicked: its tooltip may come back next time
      if (el) show(el, true)
      else if (current) hide()
    }
    const out = (e: PointerEvent) => { if (!e.relatedTarget) hide() }
    const focus = (e: FocusEvent) => {
      const el = (e.target as Element).closest?.<HTMLElement>(TARGET)
      if (el && el.matches(':focus-visible')) show(el)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerout', out)
    // a click hides the tooltip, and it stays hidden while the pointer is still on what was clicked
    const down = (e: PointerEvent) => { pressed = (e.target as Element).closest?.<HTMLElement>(TARGET) ?? null; hide() }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', hide)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerout', out)
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
    const owner = tip.el
    const described = owner.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? []
    if (tip.text !== owner.getAttribute('aria-label')) owner.setAttribute('aria-describedby', [...described, el.id].join(' '))
    const r = owner.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const above = r.top - h - 6 >= 4
    el.style.top = `${above ? r.top - h - 6 : r.bottom + 6}px`
    el.style.left = `${Math.min(Math.max(4, r.left + r.width / 2 - w / 2), window.innerWidth - w - 4)}px`
    el.dataset.side = above ? 'top' : 'bottom'
    return () => {
      const remaining = (owner.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && id !== el.id)
      if (remaining.length) owner.setAttribute('aria-describedby', remaining.join(' '))
      else owner.removeAttribute('aria-describedby')
      try { el.hidePopover() } catch { /* not shown */ }
    }
  }, [tip])

  if (!tip) return null
  return <div ref={ref} id="harness-tooltip" popover="manual" role="tooltip" className="tooltip">{tip.text}</div>
}
