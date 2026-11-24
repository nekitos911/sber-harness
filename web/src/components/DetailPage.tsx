import { useEffect, useRef, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { closeDetail } from '../store'

/**
 * The top line of a detail page (a task, a PR): «‹ Список · crumbs» and icon actions on the right. Esc goes back to the
 * list unless a dialog or popover is open; in a text field Esc only leaves the field (its blur saves it).
 */
export function DetailBar({ back, crumbs, children }: { back: string; crumbs?: ReactNode; children?: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null)
  // the list under the page is inert now: focus starts on the page (Tab reaches «‹ back» first)
  useEffect(() => { ref.current?.closest<HTMLElement>('.detail-page')?.focus({ preventScroll: true }) }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open], .popover')) return
      const field = (e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')
      if (field) { (field as HTMLElement).blur(); return }
      closeDetail()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="dp-bar">
      <button ref={ref} type="button" className="dp-back" onClick={closeDetail} data-tip="Назад к списку (Esc)"><ChevronLeft aria-hidden />{back}</button>
      {crumbs && <span className="dp-crumbs">{crumbs}</span>}
      <span className="grow" />
      {children}
    </div>
  )
}

/** A labelled column of a detail page's meta row (Статус · Агент · …) or its side column. */
export function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dp-meta-item">
      <span className="dp-label">{label}</span>
      <div className="dp-meta-value">{children}</div>
    </div>
  )
}
