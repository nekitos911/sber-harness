import { useState } from 'react'
import { Bot, ChevronUp, Cpu } from 'lucide-react'
import { tryApi } from '../../api'
import { openSession, useStore } from '../../store'
import { plural, relTime, tokens } from '../../lib/format'
import { useNow } from '../../lib/useNow'
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
        {busy > 0 && <span className="muted">— в работе: {busy}</span>}
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
          <span className="mono muted num">
            {w.tokensIn + w.tokensOut > 0 && `${tokens(w.tokensIn + w.tokensOut)} · `}
            {relTime(w.lastActivityAt, now)}
          </span>
          {w.status === 'running' && (
            <button type="button" className="link-btn" onClick={() => void tryApi('POST', `/sessions/${w.id}/stop`)}>Остановить</button>
          )}
        </div>
      ))}
      {open && internal.length > 0 && (
        <>
          <div className="workers-sub">внутренние агенты{sub && sub.problems.length > 0 && <span title={sub.problems.join('\n')}> · пропущено записей: {sub.problems.length}</span>}</div>
          {internal.map((a) => <InternalRow key={a.id} a={a} now={now} />)}
        </>
      )}
    </div>
  )
}

function InternalRow({ a, now }: { a: SubAgent; now: number }) {
  const doing = a.activity?.tool ?? a.lastText?.split('\n').filter(Boolean).pop()
  const at = a.activity?.since ?? a.lastActivity
  return (
    <div className="worker-row worker-internal" data-state={a.state} title={`${a.name} — ${subStateLabel(a.state)}${a.lastText ? `\n${a.lastText}` : ''}`}>
      <Cpu className="worker-bot" aria-hidden />
      <SubStateIcon state={a.state} />
      <span className="worker-title ellipsis">
        {a.name}
        {doing && <span className="muted"> · {doing}</span>}
      </span>
      <span className="mono muted num">
        {a.tokensIn + a.tokensOut > 0 && `${tokens(a.tokensIn + a.tokensOut)} · `}
        {a.state === 'unverifiable' ? 'нет сигнала' : at ? relTime(at, now) : subStateLabel(a.state)}
      </span>
    </div>
  )
}
