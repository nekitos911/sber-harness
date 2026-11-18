import { useRef, useState } from 'react'
import { MessageSquare, Play } from 'lucide-react'
import { openSession } from '../../store'
import { statusLabel } from '../../lib/format'
import { taskKey } from '../../lib/tasks'
import { sessionVisualState, STATE_LABEL } from '../../lib/sessionState'
import type { Session, Task } from '../../types'
import { StatusIcon } from '../bits'
import { HandoffPopover } from './Rework'

/** «Задачи» as a list: key, title, the tracker's status, the agent's state; «Передать агенту» / «Открыть сессию». */
export function TaskList({ ids, byId, sessions, onOpen }: { ids: string[]; byId: Map<string, Task>; sessions: Map<string, Session>; onOpen: (id: string) => void }) {
  return (
    <div className="task-list" role="list" data-tip-quiet>
      {ids.map((id) => {
        const t = byId.get(id)
        return t ? <TaskRow key={id} t={t} byId={byId} session={t.assigneeSessionId ? sessions.get(t.assigneeSessionId) : undefined} onOpen={onOpen} /> : null
      })}
    </div>
  )
}

function TaskRow({ t, byId, session, onOpen }: { t: Task; byId: Map<string, Task>; session?: Session; onOpen: (id: string) => void }) {
  const [handing, setHanding] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const v = session ? sessionVisualState(session) : null
  const running = v === 'running' || v === 'starting'
  return (
    <div className="task-row" role="listitem" data-child={t.parentId ? true : undefined}>
      <button type="button" className="task-row-main" onClick={() => onOpen(t.id)}>
        <span className="mono task-row-key">{t.parentId ? <span data-tip={`подзадача ${taskKey(t, byId)}`}>↳ {t.externalId ?? t.id}</span> : taskKey(t, byId)}</span>
        <span className="task-row-title">{t.title}</span>
      </button>
      <span className="chip task-row-status">{t.externalStatus ?? statusLabel(t.status)}</span>
      <span className="task-row-agent">
        {session && v && <><StatusIcon session={session} /><span>{STATE_LABEL[v]}</span></>}
      </span>
      <span className="task-row-actions">
        {session ? (
          <button type="button" className="btn btn-sm" onClick={() => openSession(session.id)}><MessageSquare />{t.status === 'done' ? 'Открыть результат' : 'Открыть сессию'}</button>
        ) : null}
        {/* a finished task is not handed out again: «Доработать» in the task does that */}
        {!running && t.status !== 'done' && (
          <>
            <button ref={btn} type="button" className="btn btn-sm" aria-expanded={handing} onClick={() => setHanding(true)}><Play />Передать агенту</button>
            {handing && <HandoffPopover task={t} anchor={btn} open onClose={() => setHanding(false)} />}
          </>
        )}
      </span>
    </div>
  )
}
