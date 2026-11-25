import { useRef, useState } from 'react'
import { MessageSquare, Play } from 'lucide-react'
import { openSession } from '../../store'
import { statusLabel } from '../../lib/format'
import { taskKey, trackerDiffers } from '../../lib/tasks'
import { dur, sessionVisualState, STATE_LABEL } from '../../lib/sessionState'
import { agentChip, chipStates } from '../../lib/agentChip'
import { useNow } from '../../lib/useNow'
import type { Session, Task } from '../../types'
import { StatusIcon } from '../bits'
import { HandoffPopover } from './Rework'
import { chipChat } from './TaskCard'

/** «Задачи» as a table: key, title, the board status (and the tracker's when it differs), the agent's state, one next step. */
export function TaskList({ ids, byId, sessions, onOpen }: { ids: string[]; byId: Map<string, Task>; sessions: Map<string, Session>; onOpen: (id: string) => void }) {
  return (
    <div className="task-list" role="table" aria-label="Задачи" data-tip-quiet>
      <div className="task-row task-head" role="row">
        <span role="columnheader">Ключ</span>
        <span role="columnheader">Задача</span>
        <span role="columnheader">Статус</span>
        <span role="columnheader">Агент</span>
        <span role="columnheader" aria-label="Действие" />
      </div>
      {ids.map((id) => {
        const t = byId.get(id)
        return t ? <TaskRow key={id} t={t} byId={byId} sessions={sessions} session={t.assigneeSessionId ? sessions.get(t.assigneeSessionId) : undefined} onOpen={onOpen} /> : null
      })}
    </div>
  )
}

function TaskRow({ t, byId, sessions, session, onOpen }: { t: Task; byId: Map<string, Task>; sessions: Map<string, Session>; session?: Session; onOpen: (id: string) => void }) {
  const [handing, setHanding] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const v = session ? sessionVisualState(session) : null
  return (
    <div className="task-row" role="row" data-child={t.parentId ? true : undefined} data-status={t.status}>
      <span role="cell" className="mono task-row-key">{t.parentId ? t.externalId ?? t.id : taskKey(t, byId)}</span>
      <span role="cell" className="task-row-cell-main">
        <button type="button" className="task-row-main" onClick={() => onOpen(t.id)}>
          {t.parentId && <span className="task-row-parent mono" data-tip={`Подзадача ${taskKey(byId.get(t.parentId) ?? t, byId)}`} aria-hidden>↳</span>}
          <span className="task-row-title">{t.title}</span>
        </button>
      </span>
      <span role="cell" className="task-row-status">
        <span className="col-mark" data-s={t.status} aria-hidden />
        <span className="ellipsis">{statusLabel(t.status)}</span>
        {trackerDiffers(t) && <span className="task-row-ext ellipsis" data-tip="Статус в трекере">{t.externalStatus}</span>}
      </span>
      <span role="cell" className="task-row-agent">
        {session && v ? (chipStates(t) ? <HarnessState t={t} session={session} sessions={sessions} /> : <><StatusIcon session={session} /><span className="ellipsis">{STATE_LABEL[v]}</span></>)
          : null}
      </span>
      <span role="cell" className="task-row-actions">
        {/* one next step per row: the agent's chat once there is one, else the hand-off (a done task is reworked from its page) */}
        {session ? (
          <button type="button" className="btn btn-sm" onClick={() => openSession(session.id)}><MessageSquare />{t.status === 'done' ? 'Результат' : 'Открыть чат'}</button>
        ) : t.status !== 'done' && (
          <>
            <button ref={btn} type="button" className="btn btn-sm" aria-expanded={handing} onClick={() => setHanding(true)}><Play />Передать агенту</button>
            {handing && <HandoffPopover task={t} anchor={btn} open onClose={() => setHanding(false)} />}
          </>
        )}
      </span>
    </div>
  )
}

/** The harness checks or reviews the task: the same explained state as the board card (agentChip), a click opens that chat. */
function HarnessState({ t, session, sessions }: { t: Task; session: Session; sessions: Map<string, Session> }) {
  const now = useNow()
  const r = t.review?.reviewerSessionId ? sessions.get(t.review.reviewerSessionId) : undefined
  const c = agentChip(t, chipChat(session), r ? chipChat(r) : null, now, dur)
  return (
    <button type="button" className="agent-badge" data-tone={c.tone} data-stalled={c.stalled || undefined} data-tip={c.tip} aria-label={`${c.text}. ${c.tip}`} onClick={() => c.open && openSession(c.open)}>
      {c.text}
    </button>
  )
}
