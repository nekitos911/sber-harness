import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button, IconButton } from './controls'

interface Props {
  title: string
  submitLabel: string
  cancelLabel?: string
  onSubmit: () => void
  onClose: () => void
  busy?: boolean
  /** The server's current step while busy (x-job-id progress). */
  progress?: string | null
  disabled?: boolean
  wide?: boolean
  /** Destructive submit (red). */
  danger?: boolean
  /** Focus the primary button on open (instead of the first field). */
  focusSubmit?: boolean
  children: ReactNode
}

/** Native <dialog> modal: focus trap, Esc and top layer come from the platform. */
export function Modal({ title, submitLabel, cancelLabel = 'Отмена', onSubmit, onClose, busy, progress, disabled, wide, danger, focusSubmit, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const d = ref.current
    d?.showModal()
    if (focusSubmit) d?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus()
    else d?.querySelector<HTMLElement>('[data-initial-focus]')?.focus()
    return () => d?.close()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <dialog
      ref={ref}
      className="dialog"
      style={wide ? { width: 'min(640px, calc(100vw - 32px))' } : undefined}
      aria-labelledby={titleId}
      // StrictMode re-runs the mount effect (close + showModal); the stale close event must not dismiss the reopened dialog.
      onClose={(e) => { if (!e.currentTarget.open) onClose() }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          e.stopPropagation() // React bubbles through portals: a picker opened from a dialog must not submit that dialog
          if (!busy && !disabled) onSubmit()
        }}
      >
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <IconButton label="Закрыть" icon={<X />} size="sm" onClick={onClose} />
        </div>
        {children}
        <div className="dialog-actions">
          <Button size="lg" onClick={onClose}>{cancelLabel}</Button>
          <Button size="lg" type="submit" variant={danger ? 'danger' : 'primary'} className={danger ? 'btn-primary' : undefined} busy={busy} disabled={disabled}>{busy ? progress || 'Подождите…' : submitLabel}</Button>
        </div>
      </form>
    </dialog>
  )
}
