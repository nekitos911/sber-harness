import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { tryApi } from '../../api'
import { openSession, useStore } from '../../store'
import { plural, relTime, tokens } from '../../lib/format'
import { useNow } from '../../lib/useNow'
import { useCurrentTool, useStartingLabel } from '../../lib/live'
import type { Session, SubAgent } from '../../types'
import { StatusIcon, statusText, SubStateIcon, subStateLabel } from '../bits'

const BUSY = new Set(['working', 'restarting', 'compacting'])

/**
 * Above the composer: harness workers (real chats: open, stop) and the agent's own internal
 * sub-agents from its registry (read-only, no actions).
 */
export function WorkersPanel({ sessionId, workers }: { sessionId: string; workers: Session[] }) {
  const sub = useStore((s) => s.subagents[sessionId])
  const [open, setOpen] = useState(true)
  const now = useNow()
  const internal = sub?.items ?? []
  if (!workers.length && !internal.length) return null

  const total = workers.length + internal.length
  const busy = workers.filter((w) => w.status === 'running').length + internal.filter((a) => BUSY.has(a.state)).length

  return (
    <div className="workers">
      <button type="button" className="workers-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{total} {plural(total, 'агент', 'агента', 'агентов')}</span>
        {busy > 0 && <span className="workers-busy">В работе: {busy}</span>}
        <span className="grow" />
        <ChevronDown className="chev" aria-hidden />
      </button>
      <div className="collapse" data-open={open}>
        <div>
          {workers.map((w) => <WorkerRow key={w.id} w={w} now={now} />)}
          {internal.length > 0 && (
            <>
              <div className="workers-sub">
                Внутренние агенты
                {sub && sub.problems.length > 0 && <span title={sub.problems.join('\n')}> · пропущено записей: {sub.problems.length}</span>}
              </div>
              {internal.map((a) => <InternalRow key={a.id} a={a} now={now} />)}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function WorkerRow({ w, now }: { w: Session; now: number }) {
  const tool = useCurrentTool(w)
  const starting = useStartingLabel(w)
  const last = w.preview.split('\n').map((l) => l.trim()).filter(Boolean).pop()
  const doing = starting || tool || (w.status === 'running' ? 'работает' : last)
  return (
    <div className="worker-row" data-enter={w.createdAt > Date.now() - 3000 || undefined}>
      <StatusIcon session={w} />
      <button type="button" className="worker-title ellipsis" onClick={() => openSession(w.id)} title={`${w.title}: ${statusText(w)}`}>
        {w.title}
        {doing && <span className="muted"> · {doing}</span>}
      </button>
      <span className="worker-meta mono num">
        {w.tokensIn + w.tokensOut > 0 && <span title="токены">{tokens(w.tokensIn + w.tokensOut)}</span>}
        <span>{relTime(w.lastActivityAt, now)}</span>
      </span>
      {w.status === 'running' && (
        <button type="button" className="link-btn" onClick={() => void tryApi('POST', `/sessions/${w.id}/stop`)}>Остановить</button>
      )}
    </div>
  )
}

function InternalRow({ a, now }: { a: SubAgent; now: number }) {
  const doing = a.activity?.tool ?? a.lastText?.split('\n').filter(Boolean).pop()
  const at = a.activity?.since ?? a.lastActivity
  return (
    <div className="worker-row worker-internal" data-state={a.state} title={`${a.name}: ${subStateLabel(a.state)}${a.lastText ? `\n${a.lastText}` : ''}`}>
      <SubStateIcon state={a.state} />
      <span className="worker-title ellipsis">
        {a.name}
        {doing && <span className="muted"> · {doing}</span>}
      </span>
      <span className="worker-meta mono num">
        {a.tokensIn + a.tokensOut > 0 && <span>{tokens(a.tokensIn + a.tokensOut)}</span>}
        <span>{a.state === 'unverifiable' ? 'нет сигнала' : at ? relTime(at, now) : subStateLabel(a.state)}</span>
      </span>
    </div>
  )
}
