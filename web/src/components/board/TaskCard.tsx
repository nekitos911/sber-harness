import { memo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { Check, CircleDot, LoaderCircle, MessageSquare, PauseCircle, RotateCcw, X, ExternalLink, FolderGit2, GitCommitHorizontal, GitCompare, GitMerge, GitPullRequest, Link2, ListChecks, Lock, Play, Wrench } from 'lucide-react'
import { PRIORITY } from '../../lib/format'
import { pendingDeps, taskKey, trackerDiffers, unusualTargets } from '../../lib/tasks'
import type { AgentInfo, Priority, Session, Task, Workspace } from '../../types'
import { StatusIcon, statusText } from '../bits'
import { dur, sessionVisualState, STATE_LABEL } from '../../lib/sessionState'
import { useCurrentTool, useStateLine, useTurnStart } from '../../lib/live'
import { useNow } from '../../lib/useNow'
import { ago, normPath, plural } from '../../lib/format'
import { PrGlyph } from '../PrChip'
import { openDialog, openSession, openTab, openWorktree, showPanel, useFeature, useStore, wtKey } from '../../store'
import { HandoffPopover, ReworkPopover } from './Rework'
import { agentChip, chipStates, type ChipChat } from '../../lib/agentChip'
import { tryApi } from '../../api'

export interface BoardCtx {
  byId: Map<string, Task>
  kids: Map<string, Task[]>
  sessions: Map<string, Session>
  workspaces: Map<string, Workspace>
  agents: Map<string, AgentInfo>
  onOpen: (id: string) => void
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
  // a blocked task gets no hand-off button: its «блок: …» chip already says why
  const canStart = (task.status === 'backlog' || task.status === 'todo') && session?.status !== 'running' && !waiting.length
  const startRef = useRef<HTMLButtonElement>(null)
  const [starting, setStarting] = useState(false) // the same «Передать агенту» popover as in the task drawer

  return (
    <>
      <div className="card-top">
        <span className="card-id mono">{task.parentId ? task.id : key}</span>
        {/* the tracker link sits by the key: a footer row of its own made every imported card a line taller */}
        {task.externalUrl && (
          <a className="card-link" href={task.externalUrl} target="_blank" rel="noreferrer noopener" aria-label="Открыть в трекере" data-tip="Открыть в трекере" onClick={stop} onKeyDown={stop} onPointerDown={stop}>
            <ExternalLink />
          </a>
        )}
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
          aria-label={`Передать агенту ${task.id}`}
          onPointerDown={stop}
          onKeyDown={stop}
          ref={startRef}
          aria-expanded={starting}
          onClick={(e) => { e.stopPropagation(); setStarting(true) }}
        >
          <Play />
          Передать агенту
        </button>
      )}
      {/* the popover lives in <body>, but its events still bubble here in React: keep them off the card (open, drag) */}
      {starting && (
        <span className="contents" onPointerDown={stop} onKeyDown={stop} onClick={stop}>
          <HandoffPopover task={task} anchor={startRef} open onClose={() => setStarting(false)} />
        </span>
      )}
      {ctx.trackerSync[task.id] && <span className="card-sync" role="status">{ctx.trackerSync[task.id].text}</span>}
      {(session || task.assigneeSessionId || goneOf(task)) && (
        <div className="card-foot">
          {!session && <AgentGone task={task} ctx={ctx} />}
          {session && (chipStates(task) ? <AgentBadge task={task} session={session} ctx={ctx} /> : <CardLive task={task} session={session} />)}
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

/** The task's agent went away (task log agent_gone) and no agent took the task since. */
function goneOf(task: Task): { how: string; sessionId?: string } | null {
  for (let i = task.log.length - 1; i >= 0; i--) {
    const e = task.log[i]
    if (e.type === 'agent_gone') return { how: String(e.data?.how ?? 'removed'), sessionId: e.data?.sessionId as string | undefined }
    if (e.type === 'started' || e.type === 'rework') return null
  }
  return null
}

/** «агент удалён» / «агент в архиве» (+ «Открыть из архива»: the chat opens read-only, with «Вернуть»). */
function AgentGone({ task, ctx }: { task: Task; ctx: BoardCtx }) {
  const gone = goneOf(task)
  if (!gone) return task.assigneeSessionId ? <span className="card-agent muted">агент удалён</span> : null // older servers: a dangling assignee
  const archived = gone.how !== 'removed' && !!gone.sessionId && ctx.sessions.has(gone.sessionId)
  return (
    <span className="card-agent muted">
      {archived ? 'агент в архиве' : 'агент удалён'}
      {archived && (
        <button type="button" className="btn btn-ghost btn-xs" onPointerDown={stop} onKeyDown={stop}
          onClick={(e) => { e.stopPropagation(); openSession(gone.sessionId!) }}>Открыть из архива</button>
      )}
    </span>
  )
}
const WAITS = new Set(['waiting_answer', 'waiting_permission', 'auth', 'stalled'])

/**
 * The card's live line: what its agent does now («Выполняет: Edit sum.js · 2 мин», «ждёт разрешения 3 мин»,
 * «агент закончил»), the worktree's uncommitted changes, one click into the chat; once it finished, what to do next.
 */
function CardLive({ task, session }: { task: Task; session: Session }) {
  const v = sessionVisualState(session)
  const tool = useCurrentTool(session)
  const line = useStateLine(session)
  const start = useTurnStart(session)
  const now = useNow()
  const reworkOn = useFeature('rework')
  const [reworking, setReworking] = useState(false)
  const reworkRef = useRef<HTMLButtonElement>(null)
  const cwd = session.worktreePath ?? session.cwd
  const changed = useStore((st) => st.git[wtKey(cwd)]?.status?.files.filter((f) => !f.service).length
    ?? Object.values(st.worktrees).flat().find((w) => normPath(w.path) === normPath(cwd))?.dirty
    ?? task.worktrees?.find((w) => normPath(w.path) === normPath(cwd))?.dirty ?? 0)
  // its turn is over on a task still open: the next step is the person's (look at the diff, commit, PR, rework)
  const finished = task.agentState === 'done' || v === 'done' || (v === 'idle' && (task.status === 'review' || task.status === 'in_progress'))
  const since = session.lastEventAt ?? session.lastActivityAt
  const text = v === 'running' && tool ? `Выполняет: ${tool}`
    : WAITS.has(v) ? `${STATE_LABEL[v]} ${dur(now - since)}`
      : finished ? `агент закончил ${ago(session.lastActivityAt, now)}`
        : line || statusText(session)
  const go = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn() }
  return (
    <div className="card-live" data-s={v}>
      <div className="card-live-row">
        <button type="button" className="card-live-line" data-tip={`${session.title}: открыть чат`} onPointerDown={stop} onKeyDown={stop} onClick={go(() => openSession(session.id))}>
          <StatusIcon session={session} />
          <span className="ellipsis">{text}</span>
          {v === 'running' && tool && start && <span className="muted num">{dur(now - start)}</span>}
        </button>
        {changed > 0 && <span className="card-changes num" data-tip={`${changed} ${plural(changed, 'незакоммиченный файл', 'незакоммиченных файла', 'незакоммиченных файлов')}`}>±{changed}</span>}
      </div>
      {finished && (
        <div className="card-actions" onPointerDown={stop} onKeyDown={stop}>
          <button type="button" className="btn btn-ghost btn-xs" onClick={go(() => openTab({ kind: 'diff', cwd, path: null }))}><GitCompare />Дифф</button>
          {changed > 0 && <button type="button" className="btn btn-ghost btn-xs" onClick={go(() => { openWorktree(cwd); showPanel('changes') })}><GitCommitHorizontal />Коммит</button>}
          {!task.pr && <button type="button" className="btn btn-ghost btn-xs" onClick={go(() => openDialog({ kind: 'pr', cwd }))}><GitPullRequest />PR</button>}
          {reworkOn && (
            <>
              <button ref={reworkRef} type="button" className="btn btn-ghost btn-xs" aria-expanded={reworking} onClick={go(() => setReworking(true))}><Wrench />Доработать</button>
              {reworking && <span className="contents" onClick={stop}><ReworkPopover task={task} anchor={reworkRef} open onClose={() => setReworking(false)} /></span>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Session -> what agentChip needs: its visual state, words and since when it is in it. */
export const chipChat = (s: Session): ChipChat => {
  const v = sessionVisualState(s)
  return { id: s.id, title: s.title, state: v, label: STATE_LABEL[v], since: s.finishedAt ?? s.lastEventAt ?? s.lastActivityAt, archived: s.archived, queued: s.queued }
}

/**
 * What the harness does with the task (checks, review) and since when; the tooltip names the chat a click opens.
 * A review nobody runs reads as stalled; a stopped or stuck one offers «Повторить ревью» (feature review-retry).
 */
export function AgentBadge({ task, session, ctx }: { task: Task; session: Session; ctx: BoardCtx }) {
  const now = useNow()
  const retryOn = useFeature('review-retry')
  const [busy, setBusy] = useState(false)
  const rid = task.review?.reviewerSessionId
  const reviewer = (rid ? ctx.sessions.get(rid) : undefined)
    ?? (task.review ? undefined : [...ctx.sessions.values()].filter((x) => x.parentId === session.id && x.role === 'reviewer').sort((a, b) => b.createdAt - a.createdAt)[0])
  const c = agentChip(task, chipChat(session), reviewer ? chipChat(reviewer) : null, now, dur)
  const Icon = c.spin ? LoaderCircle : c.stalled ? PauseCircle : c.tone === 'fail' ? X : c.tone === 'wait' ? CircleDot : Check
  const go = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn() }
  const retry = async () => {
    setBusy(true)
    await tryApi('POST', `/tasks/${encodeURIComponent(task.id)}/review`)
    setBusy(false)
  }
  return (
    <span className="agent-badge-wrap" onPointerDown={stop} onKeyDown={stop}>
      <button type="button" className="agent-badge" data-tone={c.tone} data-stalled={c.stalled || undefined} data-tip={c.tip} aria-label={`${c.text}. ${c.tip}`}
        onClick={go(() => c.open && openSession(c.open))}>
        <Icon className={c.spin ? 'spinner' : undefined} aria-hidden />
        {c.text}
      </button>
      {task.agentState === 'review_stopped' && (
        <button type="button" className="btn btn-ghost btn-xs" onClick={go(() => openSession(session.id))}><MessageSquare />Чат агента</button>
      )}
      {c.retry && retryOn && (
        <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={go(() => void retry())}
          data-tip="Запустить ревью силами harness ещё раз"><RotateCcw className={busy ? 'spinner' : undefined} />Повторить ревью</button>
      )}
    </span>
  )
}
