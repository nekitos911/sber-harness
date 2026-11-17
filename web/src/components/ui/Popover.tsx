import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react'

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start'

interface Props {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  placement?: Placement
  /** Match the anchor's width (selects). */
  matchWidth?: boolean
  className?: string
  style?: CSSProperties
  label?: string
  role?: string
  /** Element to focus when the popover opens (default: first focusable inside). */
  initialFocus?: RefObject<HTMLElement | null>
  children: ReactNode
}

const GAP = 4
const MARGIN = 8

/**
 * Anchored floating panel in the browser's top layer (the popover API), so it is never clipped by
 * scroll containers and still shows above an open <dialog>. Outside click and Esc close it; Esc returns
 * focus to the anchor. It flips above/below and stays inside the viewport.
 */
export function Popover({ anchor, open, onClose, placement = 'bottom-start', matchWidth, className, style, label, role = 'dialog', initialFocus, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useLayoutEffect(() => {
    const el = ref.current
    const a = anchor.current
    if (!open || !el || !a) return
    try { el.showPopover() } catch { /* already shown or unsupported: stays inline */ }
    const place = () => {
      const r = a.getBoundingClientRect()
      if (matchWidth) el.style.minWidth = `${r.width}px`
      const w = el.offsetWidth
      const h = el.offsetHeight
      const vw = window.innerWidth
      const vh = window.innerHeight
      if (placement === 'right-start') { // submenus: beside the item, flipped left when there is no room
        const left = r.right + w + MARGIN <= vw ? r.right - 2 : Math.max(MARGIN, r.left - w + 2)
        el.style.left = `${left}px`
        el.style.top = `${Math.max(MARGIN, Math.min(r.top - 4, vh - h - MARGIN))}px`
        return
      }
      const wantTop = placement.startsWith('top')
      const fitsBelow = r.bottom + GAP + h <= vh - MARGIN
      const fitsAbove = r.top - GAP - h >= MARGIN
      const top = wantTop ? (fitsAbove || !fitsBelow ? r.top - GAP - h : r.bottom + GAP) : (fitsBelow || !fitsAbove ? r.bottom + GAP : r.top - GAP - h)
      let left = placement.endsWith('end') ? r.right - w : r.left
      left = Math.min(Math.max(MARGIN, left), vw - w - MARGIN)
      el.style.top = `${Math.max(MARGIN, Math.min(top, vh - h - MARGIN))}px`
      el.style.left = `${left}px`
      el.dataset.side = top < r.top ? 'top' : 'bottom'
    }
    place()
    const target = initialFocus?.current ?? el.querySelector<HTMLElement>('input, [role="option"], [role="menuitem"], button, [tabindex="0"]')
    target?.focus({ preventScroll: true })
    const ro = new ResizeObserver(place)
    ro.observe(el)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      try { el.hidePopover() } catch { /* not shown */ }
    }
  }, [open, anchor, placement, matchWidth, initialFocus])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return
      if ((t as Element).closest?.('.popover')) return // a nested popover (submenu, select inside a popover)
      close.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const all = document.querySelectorAll('.popover')
      if (all.length && all[all.length - 1] !== ref.current) return // only the innermost popover closes
      e.preventDefault()
      e.stopPropagation() // an Esc for the popover must not also close the dialog or drawer under it
      close.current()
      anchor.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, anchor])

  if (!open) return null
  return (
    // React events still bubble through the component tree from the top layer: keep clicks from reaching row handlers.
    <div ref={ref} popover="manual" role={role} aria-label={label} className={`popover ${className ?? ''}`} style={style} data-placement={placement} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  )
}
