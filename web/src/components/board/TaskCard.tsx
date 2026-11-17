import { memo, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { Check, CircleDot, LoaderCircle, X, ExternalLink, FolderGit2, GitMerge, Link2, ListChecks, Lock, Play } from 'lucide-react'
import { PRIORITY } from '../../lib/format'
import { pendingDeps, taskKey, trackerDiffers, unusualTargets } from '../../lib/tasks'
import type { AgentInfo, Priority, Session, Task, Workspace } from '../../types'
import { StatusIcon, statusText } from '../bits'
import { PrGlyph } from '../PrChip'
import { openSession } from '../../store'

export interface BoardCtx {
  byId: Map<string, Task>
  kids: Map<string, Task[]>
  sessions: Map<string, Session>
  workspaces: Map<string, Workspace>
  agents: Map<string, AgentInfo>
  onOpen: (id: string) => void
  onStart: (task: Task) => void
  showRepo: boolean // only when the board mixes repositories; one repo on every card is noise
  trackerSync: Record<string, { text: string }> // «трекер: перевод…» after a move with tracker sync
}

const stop = (e: MouseEvent | KeyboardEvent | PointerEvent) => e.stopPropagation()

export const TaskCard = memo(function TaskCard({ task, ctx }: { task: Task; ctx: BoardCtx }) {
  const key = taskKey(task, ctx.byId)
  const parent = task.parentId ? ctx.byId.get(task.parentId) : undefined
  const ws = task.workspaceId ? ctx.workspaces.get(task.workspaceId) : undefined
  const session = task.assigneeSessionId ? ctx.sessions.get(task.assigneeSessionId) : undefined
  const waiting = pendingDeps(task, ctx.byId)
  const kids = ctx.kids.get(task.id) ?? []
  const kidsDone = kids.filter((k) => k.status === 'done').length
  const canStart = (task.status === 'backlog' || task.status === 'todo') && session?.status !== 'running'

  return (
    <>
      <div className="card-top">
        <span className="card-id mono">{task.parentId ? task.id : key}</span>
        {parent && <span className="card-parent mono" data-tip={`Подзадача ${parent.id}: ${parent.title}`}>↳ {taskKey(parent, ctx.byId)}</span>}
        <span className="grow" />
        {task.hidden && <span className="chip">скрыта</span>}
        {trackerDiffers(task) && <span className="card-ext" data-tip="Статус в трекере">{task.externalStatus}</span>}
        {task.pr && <PrGlyph pr={task.pr} />}
        {task.priority && <PriorityMark p={task.priority} />}
      </div>
      <button type="button" className="card-title" onKeyDown={stop}>{task.title}</button>
      <div className="card-meta">
        {ws && ctx.showRepo && (
          <span className="chip" data-tip={task.branch ? `${ws.name} · ${task.branch}` : ws.name}>
            <FolderGit2 aria-hidden />
            <span className="ellipsis">{ws.name}</span>
          </span>
        )}
        {unusualTargets(task) && task.targets.map((t, i) => (
          <span key={t} className="chip chip-mono" data-tip={i === 0 ? 'Основная целевая ветка' : 'Портирование'}>
            {i > 0 && <GitMerge aria-hidden />}
            {t}
          </span>
        ))}
        {task.labels.map((l) => <span key={l} className="chip">{l}</span>)}
        {waiting.length > 0 ? (
          <span className="chip chip-fail" data-tip={`Ждёт: ${waiting.join(', ')}`}><Lock aria-hidden />блок: {waiting.join(', ')}</span>
        ) : task.deps.length > 0 && (
          <span className="chip" data-tip={`Зависит от: ${task.deps.join(', ')} — выполнены`}><Link2 aria-hidden />{task.deps.length}</span>
        )}
        {kids.length > 0 && (
          <span className={kidsDone === kids.length ? 'chip chip-done' : 'chip'} data-tip="Подзадачи: готово / всего">
            <ListChecks aria-hidden />
            <span className="num">{kidsDone}/{kids.length}</span>
          </span>
        )}
      </div>
      {canStart && (
        <button
          type="button"
          className="btn btn-sm card-start"
          data-tip={waiting.length ? `Ждёт: ${waiting.join(', ')}` : 'Агент по умолчанию, новое рабочее дерево задачи'}
          aria-label={`Взять в работу ${task.id}`}
          disabled={waiting.length > 0}
          onPointerDown={stop}
          onKeyDown={stop}
          onClick={(e) => { e.stopPropagation(); ctx.onStart(task) }}
        >
          <Play />
          Взять в работу
        </button>
      )}
      {ctx.trackerSync[task.id] && <span className="card-sync" role="status">{ctx.trackerSync[task.id].text}</span>}
      {(session || task.externalUrl) && (
        <div className="card-foot">
          {task.agentState && session ? <AgentBadge task={task} session={session} ctx={ctx} /> : session && (
            <span className="card-agent" data-tip={session.title} data-tip-trunc>
              <StatusIcon session={session} />
              <span>{ctx.agents.get(session.agent)?.label ?? session.agent}</span>
              <span className="muted">{statusText(session)}</span>
            </span>
          )}
          <span className="grow" />
          {task.externalUrl && (
            <a className="icon-btn icon-btn-sm" href={task.externalUrl} target="_blank" rel="noreferrer noopener" aria-label="Открыть в трекере" data-tip="Открыть в трекере" onClick={stop} onKeyDown={stop} onPointerDown={stop}>
              <ExternalLink />
            </a>
          )}
        </div>
      )}
    </>
  )
})

function PriorityMark({ p }: { p: Priority }) {
  const level = p === 'high' ? 3 : p === 'medium' ? 2 : 1
  return (
    <svg className="prio" data-p={p} viewBox="0 0 12 12" role="img" aria-label={`Приоритет: ${PRIORITY[p]}`}>
      <title>{`Приоритет: ${PRIORITY[p]}`}</title>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={1 + i * 4} y={8 - i * 3} width="2.5" height={3 + i * 3} rx="0.6" opacity={i < level ? 1 : 0.25} />
      ))}
    </svg>
  )
}

const AGENT_STATE: Record<NonNullable<Task['agentState']>, { text: string; tone: string; spin?: boolean }> = {
  running: { text: 'агент работает', tone: 'run', spin: true },
  waiting: { text: 'ждёт ответа', tone: 'wait' },
  done: { text: 'агент закончил', tone: 'done' },
  failed: { text: 'агент: ошибка', tone: 'fail' },
  reviewing: { text: 'ревью…', tone: 'run', spin: true },
  approved: { text: 'ревью ✓', tone: 'done' },
  changes_requested: { text: 'замечания ревью', tone: 'run' },
}

/** What the agent (and the harness review) is doing; click opens that chat (the reviewer's while reviewing). */
function AgentBadge({ task, session, ctx }: { task: Task; session: Session; ctx: BoardCtx }) {
  const st = AGENT_STATE[task.agentState!]
  const reviewer = [...ctx.sessions.values()].filter((x) => x.parentId === session.id && x.role === 'reviewer').sort((a, b) => b.createdAt - a.createdAt)[0]
  const target = (task.agentState === 'reviewing' || task.agentState === 'approved' || task.agentState === 'changes_requested') && reviewer ? reviewer : session
  const Icon = st.spin ? LoaderCircle : task.agentState === 'failed' ? X : task.agentState === 'waiting' ? CircleDot : Check
  return (
    <button type="button" className="agent-badge" data-tone={st.tone} data-tip={`${target.title}: открыть чат`}
      onPointerDown={stop} onKeyDown={stop} onClick={(e) => { e.stopPropagation(); openSession(target.id) }}>
      <Icon className={st.spin ? 'spinner' : undefined} aria-hidden />
      {st.text}
    </button>
  )
}
