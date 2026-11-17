import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { Popover } from './Popover'
import { useListNav } from './listNav'

/**
 * Free-text input with a suggestion list (replaces <datalist>, which renders as a native dropdown):
 * typing filters, ↑↓ move, Enter takes the highlighted suggestion (or submits the typed text), Esc closes.
 */
export function SuggestInput({ value, onChange, suggestions, label, placeholder, mono, onEnter, autoFocus, className }: {
  value: string
  onChange: (v: string) => void
  suggestions: string[]
  label: string
  placeholder?: string
  mono?: boolean
  /** Enter with no suggestion highlighted (e.g. «add» in a chips field). */
  onEnter?: (v: string) => void
  autoFocus?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const q = value.trim().toLowerCase()
  const shown = suggestions.filter((s) => s.toLowerCase() !== q && (!q || s.toLowerCase().includes(q))).slice(0, 12)
  const pick = (i: number) => {
    const v = shown[i]
    if (v === undefined) return
    onChange(v)
    setOpen(false)
    input.current?.focus()
  }
  const nav = useListNav(shown, () => false, pick, -1)
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (open && nav.active >= 0 && nav.active < shown.length) { e.preventDefault(); pick(nav.active); return }
      if (onEnter) { e.preventDefault(); onEnter(value); setOpen(false) }
      return
    }
    if (e.key === 'ArrowDown' && !open) { setOpen(true); return }
    if (open) nav.onKeyDown(e, { typeahead: false })
  }
  return (
    <>
      <input
        ref={input}
        className={`input ${mono ? 'mono' : ''} ${className ?? ''}`}
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open && shown.length > 0}
        aria-controls={id}
        aria-activedescendant={open && nav.active >= 0 ? `${id}-${nav.active}` : undefined}
        placeholder={placeholder}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); nav.setActive(-1) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <Popover anchor={input} open={open && shown.length > 0} onClose={() => setOpen(false)} matchWidth role="presentation" initialFocus={input}>
        <div className="listbox" role="listbox" id={id} aria-label={label}>
          {shown.map((s, i) => (
            <div
              key={s}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === nav.active}
              className="option"
              data-active={i === nav.active || undefined}
              onPointerMove={() => { if (nav.active !== i) nav.setActive(i) }}
              onPointerDown={(e) => e.preventDefault()} // keep focus in the input
              onClick={() => pick(i)}
            >
              <span className="option-label" data-mono={mono || undefined}>{s}</span>
            </div>
          ))}
        </div>
      </Popover>
    </>
  )
}
