import { forwardRef, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { Check, LoaderCircle, X } from 'lucide-react'
import { useElapsed } from '../../lib/live'

// ---------- buttons ----------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md' | 'lg'
  icon?: ReactNode
  /** Tooltip (shown by the tooltip layer). */
  tip?: string
  /** An action in flight: spinner instead of the icon, seconds after the first one, no second click. */
  busy?: boolean
}

const cls = (variant: Variant, size: string, extra?: string) =>
  ['btn', variant !== 'secondary' && `btn-${variant}`, size !== 'md' && `btn-${size}`, extra].filter(Boolean).join(' ')

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', icon, tip, className, children, type = 'button', busy, disabled, ...rest }, ref) {
  const [since, setSince] = useState(0)
  if (busy && !since) setSince(Date.now())
  if (!busy && since) setSince(0)
  const sec = useElapsed(since, !!busy)
  return (
    <button ref={ref} type={type} className={cls(variant, size, className)} data-tip={tip} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <LoaderCircle className="spinner" aria-hidden /> : icon}
      {children}
      {busy && sec >= 1 && <span className="btn-elapsed num">{sec} с</span>}
    </button>
  )
})

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string // accessible name and tooltip
  icon: ReactNode
  size?: 'sm' | 'md'
  /** Hide the tooltip (when the label is visible next to it). */
  noTip?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, icon, size = 'md', noTip, className, type = 'button', ...rest }, ref) {
  return (
    <button ref={ref} type={type} className={`icon-btn ${size === 'sm' ? 'icon-btn-sm' : ''} ${className ?? ''}`} aria-label={label} data-tip={noTip ? undefined : label} {...rest}>
      {icon}
    </button>
  )
})

// ---------- fields ----------

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; invalid?: boolean }>(function Input({ mono, invalid, className, ...rest }, ref) {
  return <input ref={ref} className={`input ${mono ? 'mono' : ''} ${className ?? ''}`} aria-invalid={invalid || undefined} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean; invalid?: boolean }>(function Textarea({ mono, invalid, className, ...rest }, ref) {
  return <textarea ref={ref} className={`textarea ${mono ? 'mono' : ''} ${className ?? ''}`} aria-invalid={invalid || undefined} {...rest} />
})

// ---------- switch, checkbox ----------

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-thumb" aria-hidden />
    </button>
  )
}

export function Checkbox({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className="checkbox" data-disabled={disabled || undefined}>
      <input type="checkbox" className="sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="checkbox-box" aria-hidden><Check /></span>
      <span className="checkbox-label">{children}</span>
    </label>
  )
}

// ---------- segmented control ----------

export interface Segment<T extends string> { value: T; label: ReactNode; hint?: string; tone?: 'access' }

/** Radio group drawn as joined buttons; arrows move the selection like native radios. */
export function Segmented<T extends string>({ value, options, onChange, label, size = 'md', disabled }: { value: T; options: Segment<T>[]; onChange: (v: T) => void; label: string; size?: 'sm' | 'md'; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const onKey = (e: KeyboardEvent) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    const i = options.findIndex((o) => o.value === value)
    const next = options[(i + dir + options.length) % options.length]
    onChange(next.value)
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
  }
  return (
    <div ref={ref} className={`segmented segmented-${size}`} role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          data-tone={o.tone}
          data-tip={o.hint}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ---------- chips ----------

export function Chip({ children, tone, mono, onRemove, removeLabel, onClick, pressed, tip }: { children: ReactNode; tone?: 'signal' | 'run' | 'done' | 'fail' | 'access'; mono?: boolean; onRemove?: () => void; removeLabel?: string; onClick?: () => void; pressed?: boolean; tip?: string }) {
  const className = ['chip', tone && `chip-${tone}`, mono && 'chip-mono'].filter(Boolean).join(' ')
  if (onClick) {
    return <button type="button" className={className} aria-pressed={pressed} data-tip={tip} onClick={onClick}>{children}</button>
  }
  return (
    <span className={className} data-tip={tip}>
      {children}
      {onRemove && (
        <button type="button" className="chip-x" aria-label={removeLabel ?? 'Убрать'} onClick={onRemove}><X /></button>
      )}
    </span>
  )
}
