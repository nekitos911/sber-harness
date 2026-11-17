import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export interface MenuItem { label: string; icon?: ReactNode; hint?: string; onSelect: () => void }

/** Icon button with a small popover menu; closes on outside click and Escape. Opens from its trigger corner. */
export function MenuButton({ label, icon, items, align = 'left', up = false }: { label: string; icon: ReactNode; items: MenuItem[]; align?: 'left' | 'right'; up?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const pos: CSSProperties = {
    [up ? 'bottom' : 'top']: 'calc(100% + 4px)',
    [align === 'left' ? 'left' : 'right']: 0,
    transformOrigin: `${up ? 'bottom' : 'top'} ${align}`,
  }

  return (
    <div
      ref={ref}
      className="menu-anchor"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus() }
      }}
    >
      <button type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((o) => !o)}>
        {icon}
      </button>
      {open && (
        <div className="menu" role="menu" style={pos}>
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" onClick={() => { setOpen(false); it.onSelect() }}>
              {it.icon}
              <span className="grow">{it.label}</span>
              {it.hint && <kbd>{it.hint}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
