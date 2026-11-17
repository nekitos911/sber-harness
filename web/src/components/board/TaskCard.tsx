import { memo, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { ExternalLink, FolderGit2, GitMerge, Link2, ListChecks, Lock, Play } from 'lucide-react'
import { PRIORITY } from '../../lib/format'
import { pendingDeps, taskKey, trackerDiffers, unusualTargets } from '../../lib/tasks'
import type { AgentInfo, Priority, Session, Task, Workspace } from '../../types'
import { StatusIcon, statusText } from '../bits'

export interface BoardCtx {
  byId: Map<string, Task>
  kids: Map<string, Task[]>
  sessions: Map<string, Session>
  workspaces: Map<string, Workspace>
  agents: Map<string, AgentInfo>
  onOpen: (id: string) => void
  onStart: (task: Task) => void
  showRepo: boolean // only when the board mixes repositories; one repo on every card is noise
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
        {parent && <span className="card-parent mono" title={`Подзадача ${parent.id}: ${parent.title}`}>↳ {taskKey(parent, ctx.byId)}</span>}
        <span className="grow" />
        {task.hidden && <span className="chip">скрыта</span>}
        {trackerDiffers(task) && <span className="card-ext" title="Статус в трекере">{task.externalStatus}</span>}
        {task.priority && <PriorityMark p={task.priority} />}
      </div>
      <button type="button" className="card-title" onKeyDown={stop}>{task.title}</button>
      <div className="card-meta">
        {ws && ctx.showRepo && (
          <span className="chip" title={task.branch ? `${ws.name} · ${task.branch}` : ws.name}>
            <FolderGit2 aria-hidden />
            <span className="ellipsis">{ws.name}</span>
          </span>
        )}
        {unusualTargets(task) && task.targets.map((t, i) => (
          <span key={t} className="chip chip-mono" title={i === 0 ? 'Основная целевая ветка' : 'Портирование'}>
            {i > 0 && <GitMerge aria-hidden />}
            {t}
          </span>
        ))}
        {task.labels.map((l) => <span key={l} className="chip">{l}</span>)}
        {waiting.length > 0 ? (
          <span className="chip chip-fail" title={`Ждёт: ${waiting.join(', ')}`}><Lock aria-hidden />блок: {waiting.join(', ')}</span>
        ) : task.deps.length > 0 && (
          <span className="chip" title={`Зависит от: ${task.deps.join(', ')} — выполнены`}><Link2 aria-hidden />{task.deps.length}</span>
        )}
        {kids.length > 0 && (
          <span className={kidsDone === kids.length ? 'chip chip-done' : 'chip'} title="Подзадачи: готово / всего">
            <ListChecks aria-hidden />
            <span className="num">{kidsDone}/{kids.length}</span>
          </span>
        )}
      </div>
      {canStart && (
        <button
          type="button"
          className="btn btn-sm card-start"
          title={waiting.length ? `Ждёт: ${waiting.join(', ')}` : 'Агент по умолчанию, новое рабочее дерево задачи'}
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
      {(session || task.externalUrl) && (
        <div className="card-foot">
          {session && (
            <span className="card-agent" title={session.title}>
              <StatusIcon session={session} />
              <span>{ctx.agents.get(session.agent)?.label ?? session.agent}</span>
              <span className="muted">{statusText(session)}</span>
            </span>
          )}
          <span className="grow" />
          {task.externalUrl && (
            <a className="icon-btn icon-btn-sm" href={task.externalUrl} target="_blank" rel="noreferrer noopener" aria-label="Открыть в трекере" title="Открыть в трекере" onClick={stop} onKeyDown={stop} onPointerDown={stop}>
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
