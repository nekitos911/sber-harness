import { useEffect, useId, useRef, type ReactNode } from 'react'

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
      onClose={onClose}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy && !disabled) onSubmit()
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn btn-primary" disabled={busy || disabled}>{busy ? 'Подождите…' : submitLabel}</button>
        </div>
      </form>
    </dialog>
  )
}
