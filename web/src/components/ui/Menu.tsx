import { useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ChevronRight } from 'lucide-react'
import { Popover, type Placement } from './Popover'
import { useListNav } from './listNav'

export interface MenuItem {
  label: string
  icon?: ReactNode
  hint?: string
  danger?: boolean
  disabled?: boolean
  /** A divider before this item. */
  divider?: boolean
  /** Submenu (opens to the right on hover, → or Enter). */
  children?: MenuItem[]
  onSelect?: () => void
}

/** Controlled dropdown/context menu: arrows/typeahead/Enter, → opens a submenu, ← or Esc closes it. */
export function Menu({ anchor, open, onClose, items, label, placement = 'bottom-start' }: {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  items: MenuItem[]
  label: string
  placement?: Placement
}) {
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const [sub, setSub] = useState<number | null>(null)
  const rows = useRef<(HTMLDivElement | null)[]>([])
  const pick = (i: number) => {
    const it = items[i]
    if (!it || it.disabled) return
    if (it.children) { setSub(i); return }
    onClose()
    it.onSelect?.()
  }
  const nav = useListNav(items.map((i) => i.label), (i) => !!items[i]?.disabled, pick)
  const subAnchor = { current: sub === null ? null : rows.current[sub] } as RefObject<HTMLElement | null>
  return (
    <Popover anchor={anchor} open={open} onClose={() => { setSub(null); onClose() }} placement={placement} role="presentation" initialFocus={list}>
      <div
        ref={list}
        className="menu-list"
        role="menu"
        aria-label={label}
        tabIndex={-1}
        aria-activedescendant={`${id}-${nav.active}`}
        onKeyDown={(e) => {
          if (e.key === 'Tab') { onClose(); return }
          if (e.key === 'ArrowRight' && items[nav.active]?.children) { e.preventDefault(); setSub(nav.active); return }
          nav.onKeyDown(e)
        }}
      >
        {items.map((it, i) => (
          <div key={it.label} role="presentation">
            {it.divider && <div className="menu-divider" role="separator" />}
            <div
              ref={(el) => { rows.current[i] = el }}
              id={`${id}-${i}`}
              role="menuitem"
              aria-haspopup={it.children ? 'menu' : undefined}
              aria-expanded={it.children ? sub === i : undefined}
              aria-disabled={it.disabled || undefined}
              className="option"
              data-danger={it.danger || undefined}
              data-active={i === nav.active || undefined}
              onPointerMove={() => { if (nav.active !== i) nav.setActive(i); setSub(it.children ? i : null) }}
              onClick={() => pick(i)}
            >
              {it.icon}
              <span className="option-main"><span className="option-label">{it.label}</span></span>
              {it.hint && <kbd>{it.hint}</kbd>}
              {it.children && <ChevronRight className="submenu-chev" aria-hidden />}
            </div>
          </div>
        ))}
      </div>
      {sub !== null && items[sub]?.children && (
        <SubMenu anchor={subAnchor} items={items[sub].children!} label={items[sub].label}
          onClose={() => { setSub(null); list.current?.focus() }} onDone={() => { setSub(null); onClose() }} />
      )}
    </Popover>
  )
}

function SubMenu({ anchor, items, label, onClose, onDone }: { anchor: RefObject<HTMLElement | null>; items: MenuItem[]; label: string; onClose: () => void; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const pick = (i: number) => { const it = items[i]; if (!it || it.disabled) return; onDone(); it.onSelect?.() }
  const nav = useListNav(items.map((i) => i.label), (i) => !!items[i]?.disabled, pick)
  return (
    <Popover anchor={anchor} open onClose={onClose} placement="right-start" role="presentation" initialFocus={ref}>
      <div ref={ref} className="menu-list" role="menu" aria-label={label} tabIndex={-1}
        onKeyDown={(e) => { if (e.key === 'ArrowLeft') { e.preventDefault(); onClose() } else nav.onKeyDown(e) }}>
        {items.map((it, i) => (
          <div key={it.label} role="menuitem" aria-disabled={it.disabled || undefined} className="option"
            data-active={i === nav.active || undefined} onPointerMove={() => { if (nav.active !== i) nav.setActive(i) }} onClick={() => pick(i)}>
            {it.icon}
            <span className="option-main"><span className="option-label">{it.label}</span></span>
          </div>
        ))}
      </div>
    </Popover>
  )
}

/** Icon trigger with a dropdown menu. */
export function MenuButton({ label, icon, items, placement = 'bottom-start', up = false, align, className }: { label: string; icon: ReactNode; items: MenuItem[]; placement?: Placement; up?: boolean; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const place: Placement = align || up ? `${up ? 'top' : 'bottom'}-${align === 'right' ? 'end' : 'start'}` : placement
  return (
    <>
      <button ref={btn} type="button" className={`icon-btn ${className ?? ''}`} aria-haspopup="menu" aria-expanded={open} aria-label={label} data-tip={open ? undefined : label}
        onClick={(e) => { e.stopPropagation(); setOpen(!open) }}>
        {icon}
      </button>
      <Menu anchor={btn} open={open} onClose={() => setOpen(false)} items={items} label={label} placement={place} />
    </>
  )
}
