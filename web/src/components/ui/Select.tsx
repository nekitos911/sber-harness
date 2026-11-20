import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Popover, type Placement } from './Popover'
import { useListNav } from './listNav'

export interface Option<T extends string = string> {
  value: T
  label: ReactNode
  /** Plain text for typeahead and the trigger when `label` is not a string. */
  text?: string
  hint?: ReactNode
  disabled?: boolean
  icon?: ReactNode
}

interface Props<T extends string> {
  value: T
  options: Option<T>[]
  onChange: (v: T) => void
  label: string // accessible name
  placeholder?: string
  size?: 'sm' | 'md' | 'lg'
  mono?: boolean
  placement?: Placement
  className?: string
  disabled?: boolean
  autoFocus?: boolean
  invalid?: boolean
  /** Shown in the trigger instead of the option label. */
  display?: ReactNode
}

const textOf = (o: Option) => o.text ?? (typeof o.label === 'string' ? o.label : String(o.value))

/** Button + listbox popover: arrows, Home/End, typeahead, Enter/Space to pick, Esc to close. */
export function Select<T extends string>({ value, options, onChange, label, placeholder = 'Выберите…', size = 'md', mono, placement = 'bottom-start', className, disabled, autoFocus, invalid, display }: Props<T>) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const current = options.findIndex((o) => o.value === value)
  const pick = (i: number) => {
    const o = options[i]
    if (!o || o.disabled) return
    setOpen(false)
    btn.current?.focus({ preventScroll: true })
    if (o.value !== value) onChange(o.value)
  }
  const nav = useListNav(options.map(textOf), (i) => !!options[i]?.disabled, pick, Math.max(0, current))

  useEffect(() => { if (open) nav.setActive(Math.max(0, current)) }, [open])
  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>(`[data-i="${nav.active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, nav.active])

  const sel = options[current]
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`select-trigger select-${size} ${className ?? ''}`}
        data-mono={mono || undefined}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-tip={label}
        aria-label={label}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(true) }
        }}
      >
        {sel?.icon}
        <span className="select-value" data-placeholder={!sel || undefined}>{display ?? (sel ? sel.label : placeholder)}</span>
        <ChevronDown className="select-chev" aria-hidden />
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} placement={placement} matchWidth role="presentation" initialFocus={list}>
        <div
          ref={list}
          id={id}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          className="listbox"
          aria-activedescendant={`${id}-${nav.active}`}
          onKeyDown={(e) => {
            if (e.key === 'Tab') { setOpen(false); return }
            if (e.key === ' ') { e.preventDefault(); pick(nav.active); return }
            nav.onKeyDown(e)
          }}
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              id={`${id}-${i}`}
              data-i={i}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className="option"
              data-active={i === nav.active || undefined}
              onPointerMove={() => { if (!o.disabled && nav.active !== i) nav.setActive(i) }}
              onClick={() => pick(i)}
            >
              {o.icon}
              <span className="option-main">
                <span className="option-label" data-mono={mono || undefined}>{o.label}</span>
                {o.hint && <span className="option-hint">{o.hint}</span>}
              </span>
              {o.value === value && <Check className="option-check" aria-hidden />}
            </div>
          ))}
          {!options.length && <div className="option-empty">Нет вариантов</div>}
        </div>
      </Popover>
    </>
  )
}
