import { useState } from 'react'
import { Bot, ChevronUp } from 'lucide-react'
import { tryApi } from '../../api'
import { openSession } from '../../store'
import { plural, relTime } from '../../lib/format'
import { useNow } from '../../lib/useNow'
import type { Session } from '../../types'
import { StatusIcon, statusText } from '../bits'

/** Coordinator's workers, above the composer: status, what they are doing, stop. */
export function WorkersPanel({ workers }: { workers: Session[] }) {
  const [open, setOpen] = useState(true)
  const now = useNow()
  const running = workers.filter((w) => w.status === 'running').length
  return (
    <div className="workers">
      <button type="button" className="workers-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{workers.length} {plural(workers.length, 'исполнитель', 'исполнителя', 'исполнителей')}</span>
        {running > 0 && <span className="muted">— в работе: {running}</span>}
        <span className="grow" />
        <ChevronUp className="chev" aria-hidden />
      </button>
      {open && workers.map((w) => (
        <div key={w.id} className="worker-row">
          <Bot className="worker-bot" aria-hidden />
          <StatusIcon session={w} />
          <button type="button" className="worker-title ellipsis" onClick={() => openSession(w.id)} title={`${w.title} — ${statusText(w)}`}>
            {w.title}
            {w.preview && <span className="muted"> · {w.preview.split('\n').filter(Boolean).pop()}</span>}
          </button>
          <span className="mono muted num">{relTime(w.lastActivityAt, now)}</span>
          {w.status === 'running' && (
            <button type="button" className="link-btn" onClick={() => void tryApi('POST', `/sessions/${w.id}/stop`)}>Остановить</button>
          )}
        </div>
      ))}
    </div>
  )
}
