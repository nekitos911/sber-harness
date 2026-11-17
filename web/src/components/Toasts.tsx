import { X } from 'lucide-react'
import { dismissToast, useStore } from '../store'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-tone={t.tone} role={t.tone === 'error' ? 'alert' : 'status'}>
          <p>
            {t.text}
            {t.href && <> <a href={t.href} target="_blank" rel="noreferrer noopener">Открыть</a></>}
          </p>
          <button type="button" className="icon-btn icon-btn-sm" onClick={() => dismissToast(t.id)} aria-label="Закрыть уведомление">
            <X />
          </button>
        </div>
      ))}
    </div>
  )
}
