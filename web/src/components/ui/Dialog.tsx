import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button, IconButton } from './controls'

interface Props {
  title: string
  submitLabel: string
  onSubmit: () => void
  onClose: () => void
  busy?: boolean
  disabled?: boolean
  wide?: boolean
  children: ReactNode
}

/** Native <dialog> modal: focus trap, Esc and top layer come from the platform. */
export function Modal({ title, submitLabel, onSubmit, onClose, busy, disabled, wide, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const d = ref.current
    d?.showModal()
    return () => d?.close()
  }, [])

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
          if (!busy && !disabled) onSubmit()
        }}
      >
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <IconButton label="Закрыть" icon={<X />} size="sm" onClick={onClose} />
        </div>
        {children}
        <div className="dialog-actions">
          <Button size="lg" onClick={onClose}>Отмена</Button>
          <Button size="lg" type="submit" variant="primary" disabled={busy || disabled}>{busy ? 'Подождите…' : submitLabel}</Button>
        </div>
      </form>
    </dialog>
  )
}
