import { useRef, useState, type ReactNode } from 'react'
import { Popover, type Placement } from './Popover'
import { useListNav } from './listNav'

export interface MenuItem { label: string; icon?: ReactNode; hint?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }

/** Icon trigger with a dropdown menu: arrows/typeahead/Enter, Esc returns focus to the trigger. */
export function MenuButton({ label, icon, items, placement = 'bottom-start', up = false, align }: { label: string; icon: ReactNode; items: MenuItem[]; placement?: Placement; up?: boolean; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const place: Placement = align || up ? `${up ? 'top' : 'bottom'}-${align === 'right' ? 'end' : 'start'}` : placement
  const pick = (i: number) => {
    const it = items[i]
    if (!it || it.disabled) return
    setOpen(false)
    it.onSelect()
  }
  const nav = useListNav(items.map((i) => i.label), (i) => !!items[i]?.disabled, pick)
  return (
    <>
      <button ref={btn} type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={label} data-tip={open ? undefined : label} onClick={() => { nav.setActive(0); setOpen(!open) }}>
        {icon}
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} placement={place} role="presentation" initialFocus={menu}>
        <div ref={menu} className="menu-list" role="menu" aria-label={label} tabIndex={-1} onKeyDown={(e) => { if (e.key === 'Tab') setOpen(false); else nav.onKeyDown(e) }}>
          {items.map((it, i) => (
            <div
              key={it.label}
              role="menuitem"
              aria-disabled={it.disabled || undefined}
              className="option"
              data-danger={it.danger || undefined}
              data-active={i === nav.active || undefined}
              onPointerMove={() => { if (nav.active !== i) nav.setActive(i) }}
              onClick={() => pick(i)}
            >
              {it.icon}
              <span className="option-main"><span className="option-label">{it.label}</span></span>
              {it.hint && <kbd>{it.hint}</kbd>}
            </div>
          ))}
        </div>
      </Popover>
    </>
  )
}
