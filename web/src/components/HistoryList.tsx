import { useMemo, useState } from 'react'
import { History, Link2 } from 'lucide-react'
import { openSession, openTab } from '../store'
import { fullTime, relTime } from '../lib/format'
import { useHistory } from '../lib/history'
import { useNow } from '../lib/useNow'
import { Skeleton } from './bits'

/** «История GigaCode»: chats the CLI recorded for this folder, newest first; a click opens one read-only. */
export function HistoryList({ cwd }: { cwd: string }) {
  const list = useHistory(cwd)
  const now = useNow()
  const [q, setQ] = useState('')
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return (list ?? []).filter((h) => !t || `${h.title} ${h.model ?? ''}`.toLowerCase().includes(t))
  }, [list, q])
  if (list === undefined) return <Skeleton rows={3} label="Загрузка истории…" />
  if (!list.length) return <p className="muted history-empty">Сессий CLI для этой папки не найдено.</p>
  return (
    <div className="history-list">
      {list.length > 5 && <input className="input" type="search" aria-label="Фильтр истории" placeholder="Фильтр" value={q} onChange={(e) => setQ(e.target.value)} />}
      {shown.map((h) => (
        <button key={`${h.agent}:${h.id}`} type="button" className="history-row"
          onClick={() => (h.linkedSessionId ? openSession(h.linkedSessionId) : openTab({ kind: 'history', cwd, agent: h.agent, id: h.id, title: h.title }))}>
          <History aria-hidden />
          <span className="history-main">
            <span className="history-title ellipsis">{h.title || h.id}</span>
            <span className="history-meta">
              <span data-tip={fullTime(h.updatedAt ?? h.startedAt ?? 0)}>{relTime(h.updatedAt ?? h.startedAt ?? 0, now)}</span>
              {h.model && <span className="mono">{h.model}</span>}
              <span>{h.messages} сообщ.</span>
              {h.linkedSessionId && <span className="history-linked"><Link2 aria-hidden />открыта в harness</span>}
            </span>
          </span>
        </button>
      ))}
      {!shown.length && <p className="muted history-empty">Ничего не найдено.</p>}
    </div>
  )
}
