import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { dismissToast, useStore } from '../store'

const ICON = { info: Info, ok: CircleCheck, error: CircleAlert }

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICON[t.tone]
        return (
          <div key={t.id} className="toast" data-tone={t.tone} data-leaving={t.leaving || undefined} role={t.tone === 'error' ? 'alert' : 'status'}>
            <Icon className="toast-icon" aria-hidden />
            <p>
              {t.text}
              {t.href && <> <a href={t.href} target="_blank" rel="noreferrer noopener">Открыть</a></>}
            </p>
            <button type="button" className="icon-btn icon-btn-sm" onClick={() => dismissToast(t.id)} aria-label="Закрыть уведомление">
              <X />
            </button>
          </div>
        )
      })}
    </div>
  )
}
