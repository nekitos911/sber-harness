import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem { label: string; icon?: ReactNode; onSelect: () => void }

/** Icon button with a small popover menu; closes on outside click and Escape. */
export function MenuButton({ label, icon, items, align = 'left' }: { label: string; icon: ReactNode; items: MenuItem[]; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div
      ref={ref}
      style={{ position: 'relative', alignSelf: 'center' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus() }
      }}
    >
      <button type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((o) => !o)}>
        {icon}
      </button>
      {open && (
        <div className="menu" role="menu" style={align === 'left' ? { top: '100%', left: 0 } : { top: '100%', right: 0, transformOrigin: 'top right' }}>
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" onClick={() => { setOpen(false); it.onSelect() }}>
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
