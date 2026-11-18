import { useState } from 'react'
import { normPath } from '../../lib/format'
import { ChevronDown } from 'lucide-react'
import { tryApi } from '../../api'
import { openDialog, openSession, useStore } from '../../store'
import { archiveSession } from '../../lib/sessionActions'
import { plural, relTime, tokens } from '../../lib/format'
import { useNow } from '../../lib/useNow'
import { useCurrentTool, useStartingLabel } from '../../lib/live'
import type { Session, SubAgent } from '../../types'
import { StatusIcon, SubStateIcon, subStateLabel } from '../bits'

const BUSY = new Set(['working', 'restarting', 'compacting'])

/**
 * Above the composer: harness workers (real chats: open, stop) and the agent's own internal
 * sub-agents from its registry (read-only, no actions).
 */
export function WorkersPanel({ sessionId, workers }: { sessionId: string; workers: Session[] }) {
  const sub = useStore((s) => s.subagents[sessionId])
  const all = useStore((s) => s.sessions)
  const reviewers = all.filter((s) => s.role === 'reviewer' && workers.some((w) => w.id === s.parentId))
  const parent = all.find((s) => s.id === sessionId)
  // Children in another worktree (or persistent ones) are their own orchestrators: a separate group.
  // its own orchestrator: a persistent child in ANOTHER worktree (one in the same worktree is an ordinary worker)
  const place = (x: Session) => normPath(x.worktreePath ?? x.cwd)
  const elsewhere = workers.filter((w) => !w.virtual && !!w.persistent && !!parent && place(w) !== place(parent))
  const own = workers.filter((w) => !w.virtual && !elsewhere.includes(w))
  const inner = workers.filter((w) => w.virtual)
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
          {own.map((w) => (
            <div key={w.id} role="presentation">
              <WorkerRow w={w} now={now} />
              {reviewers.filter((r) => r.parentId === w.id).map((r) => <WorkerRow key={r.id} w={r} now={now} nested />)}
            </div>
          ))}
          {elsewhere.length > 0 && (
            <>
              <div className="workers-sub">Оркестраторы в других рабочих деревьях</div>
              {elsewhere.map((w) => <WorkerRow key={w.id} w={w} now={now} />)}
            </>
          )}
          {inner.length > 0 && (
            <>
              <div className="workers-sub" data-tip="Субагенты, которых GigaCode запустил сам, внутри этого чата: их видно, но писать им нельзя">Встроенные субагенты GigaCode</div>
              {inner.map((w) => <WorkerRow key={w.id} w={w} now={now} />)}
            </>
          )}
          {internal.length > 0 && (
            <>
              <div className="workers-sub">
                Внутренние агенты
                {sub && sub.problems.length > 0 && <span data-tip={sub.problems.join('\n')}> · пропущено записей: {sub.problems.length}</span>}
              </div>
              {internal.map((a) => <InternalRow key={a.id} a={a} now={now} />)}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** A harness worker stops by itself; GigaCode's built-in sub-agent lives in its parent's process — only the whole turn stops. */
function stopWorker(w: Session) {
  if (!w.virtual) return void tryApi('POST', `/sessions/${w.id}/stop`)
  openDialog({
    kind: 'confirm', title: 'Остановить весь ход чата?', danger: true, ok: 'Остановить ход',
    text: 'Это встроенный субагент GigaCode: он работает внутри процесса родительского чата, и отдельно его не остановить. Остановится текущий ход чата вместе со всеми его субагентами.',
    onConfirm: () => void tryApi('POST', `/sessions/${w.parentId}/stop`),
  })
}

function WorkerRow({ w, now, nested }: { w: Session; now: number; nested?: boolean }) {
  const tool = useCurrentTool(w)
  const starting = useStartingLabel(w)
  const lines = w.preview.split('\n').map((l) => l.trim()).filter(Boolean)
  // the server keeps the last 200 characters: a one-line tail starts mid-word («обы дожать…») — cut to a word, mark it
  const cut = lines.length === 1 && w.preview.length >= 200
  const last = cut ? `…${lines[0].replace(/^\S*\s+/, '')}` : lines.pop()
  const doing = starting || tool || (w.status === 'running' ? 'работает' : last)
  return (
    <div className="worker-row" data-nested={nested || undefined} data-enter={w.createdAt > Date.now() - 3000 || undefined}>
      <StatusIcon session={w} />
      <button type="button" className="worker-title ellipsis" onClick={() => openSession(w.id)} data-tip={w.title} data-tip-trunc>
        {(w.role === 'reviewer' || w.role === 'subagent') && <span className="role-tag">{w.role === 'reviewer' ? 'ревью' : 'субагент'}</span>}
        {w.title}
        {doing && <span className="muted"> · {doing}</span>}
      </button>
      <span className="worker-meta mono num">
        {w.tokensIn + w.tokensOut > 0 && <span data-tip="токены">{tokens(w.tokensIn + w.tokensOut)}</span>}
        <span>{relTime(w.lastActivityAt, now)}</span>
      </span>
      {w.status === 'running'
        ? <button type="button" className="link-btn" onClick={() => stopWorker(w)}>Остановить</button>
        : <button type="button" className="link-btn" onClick={() => void archiveSession(w)}>Убрать</button>}
    </div>
  )
}

function InternalRow({ a, now }: { a: SubAgent; now: number }) {
  const doing = a.activity?.tool ?? a.lastText?.split('\n').filter(Boolean).pop()
  const at = a.activity?.since ?? a.lastActivity
  return (
    <div className="worker-row worker-internal" data-state={a.state} aria-label={`${a.name}: ${subStateLabel(a.state)}`}>
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
