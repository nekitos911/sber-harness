import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { ErrorBoundary } from '../ErrorBoundary'

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
      // The wanted side when the content fits there, else the roomier one; never over the trigger: too tall → scrolls.
      const full = Math.max(h, el.scrollHeight)
      const above = r.top - GAP - MARGIN
      const below = vh - r.bottom - GAP - MARGIN
      const wantTop = placement.startsWith('top')
      const side = wantTop ? (full <= above || above >= below ? 'top' : 'bottom') : (full <= below || below >= above ? 'bottom' : 'top')
      const room = Math.max(0, side === 'top' ? above : below)
      const tall = full > room
      el.style.maxHeight = tall ? `${room}px` : ''
      el.style.overflowY = tall ? 'auto' : ''
      const hh = Math.min(full, room)
      let left = placement.endsWith('end') ? r.right - w : r.left
      left = Math.min(Math.max(MARGIN, left), vw - w - MARGIN)
      el.style.top = `${side === 'top' ? r.top - GAP - hh : r.bottom + GAP}px`
      el.style.left = `${left}px`
      el.dataset.side = side
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
    // In <body> (or the open dialog, outside of which everything is inert): fixed positioning must not depend on a
    // transformed ancestor or on a browser without the Popover API.
    createPortal(
      <div ref={ref} popover="manual" role={role} aria-label={label} className={`popover ${className ?? ''}`} style={style} data-placement={placement} onClick={(e) => e.stopPropagation()}>
        <ErrorBoundary area="это меню">{children}</ErrorBoundary>
      </div>,
      anchor.current?.closest('dialog') ?? document.body,
    )
  )
}
