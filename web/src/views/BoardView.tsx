import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  closestCorners, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors,
  type Announcements, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CloudOff, Eye, EyeOff, Plus, RefreshCw, Search } from 'lucide-react'
import { api, errorText, tryApi } from '../api'
import { getState, openDialog, setState, toast, upsert, useStore } from '../store'
import { COLUMNS, statusLabel } from '../lib/format'
import { byOrder } from '../lib/tasks'
import type { Task, TaskStatus } from '../types'
import { TaskCard, type BoardCtx } from '../components/board/TaskCard'
import { TaskDrawer } from '../components/board/TaskDrawer'
import { Select } from '../components/ui'
import { useSettings } from '../lib/agents'

type Cols = Record<TaskStatus, string[]>
const COL_PREFIX = 'col:'

export function BoardView() {
  const tasks = useStore((s) => s.tasks)
  const sessions = useStore((s) => s.sessions)
  const workspaces = useStore((s) => s.workspaces)
  const agents = useStore((s) => s.agents)
  const syncEnabled = useStore((s) => s.integrations.tasks)
  const trackerProblem = useStore((s) => s.integrations.tasksProblem)
  const focusTaskId = useStore((s) => s.focusTaskId)
  const statusMap = useSettings()?.integrations?.tasks?.statusMap

  const [query, setQuery] = useState('')
  const [repo, setRepo] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ id: string; cols: Cols; from: TaskStatus } | null>(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    if (focusTaskId) { setOpenId(focusTaskId); setState({ focusTaskId: null }) }
  }, [focusTaskId])

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  const ctx = useMemo<BoardCtx>(() => {
    const kids = new Map<string, Task[]>()
    for (const t of tasks) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t])
    return {
      byId, kids,
      sessions: new Map(sessions.map((s) => [s.id, s])),
      workspaces: new Map(workspaces.map((w) => [w.id, w])),
      agents: new Map(agents.map((a) => [a.id, a])),
      onOpen: setOpenId,
      onStart: (t) => openDialog({ kind: 'start', taskId: t.id }),
      showRepo: !repo && workspaces.length > 1,
    }
  }, [tasks, byId, sessions, workspaces, agents, repo])

  const cols = useMemo<Cols>(() => {
    const q = query.trim().toLowerCase()
    const out = Object.fromEntries(COLUMNS.map((c) => [c.id, [] as string[]])) as Cols
    for (const t of [...tasks].sort(byOrder)) {
      if (repo && t.workspaceId !== repo) continue
      if (q && ![t.id, t.title, t.externalId ?? '', ...t.labels].some((v) => v.toLowerCase().includes(q))) continue
      // Hidden tasks stay findable by their key.
      if (t.hidden && !showHidden && !(q && [t.id, t.externalId ?? ''].some((v) => v.toLowerCase().includes(q)))) continue
      out[t.status]?.push(t.id)
    }
    return out
  }, [tasks, query, repo, showHidden])

  const shown = drag?.cols ?? cols

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const colOf = (c: Cols, id: string): TaskStatus | undefined =>
    id.startsWith(COL_PREFIX) ? (id.slice(COL_PREFIX.length) as TaskStatus) : COLUMNS.find((x) => c[x.id].includes(id))?.id

  const onDragStart = ({ active }: DragStartEvent) => {
    const id = String(active.id)
    setDrag({ id, cols, from: byId.get(id)!.status })
  }

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!drag || !over) return
    const from = colOf(drag.cols, String(active.id))
    const to = colOf(drag.cols, String(over.id))
    if (!from || !to || from === to) return
    const target = drag.cols[to]
    const overIndex = target.indexOf(String(over.id))
    const rect = active.rect.current.translated
    const below = rect && overIndex >= 0 ? rect.top > over.rect.top + over.rect.height / 2 : false
    const at = overIndex >= 0 ? overIndex + (below ? 1 : 0) : target.length
    setDrag({
      ...drag,
      cols: {
        ...drag.cols,
        [from]: drag.cols[from].filter((x) => x !== active.id),
        [to]: [...target.slice(0, at), String(active.id), ...target.slice(at)],
      },
    })
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const d = drag
    setDrag(null)
    if (!d || !over) return
    const id = String(active.id)
    const col = colOf(d.cols, id)
    if (!col) return
    let list = d.cols[col]
    const overId = String(over.id)
    if (!overId.startsWith(COL_PREFIX) && list.includes(overId) && overId !== id) {
      list = arrayMove(list, list.indexOf(id), list.indexOf(overId))
    }
    const at = list.indexOf(id)
    const beforeId = list[at + 1] ?? null
    if (col === d.from && cols[col][cols[col].indexOf(id) + 1] === (beforeId ?? undefined)) return
    void move(id, col, beforeId, list[at - 1] ?? null)
  }

  /** Optimistic move; the server's answer (or the WS echo) settles the final order. */
  const move = async (id: string, status: TaskStatus, beforeId: string | null, afterId: string | null) => {
    const original = byId.get(id)
    if (!original) return
    const prev = afterId ? byId.get(afterId)?.order : undefined
    const next = beforeId ? byId.get(beforeId)?.order : undefined
    const order = prev !== undefined && next !== undefined ? (prev + next) / 2 : prev !== undefined ? prev + 1 : next !== undefined ? next - 1 : 0
    setState((s) => ({ tasks: upsert(s.tasks, { ...original, status, order }) }))
    try {
      const saved = await api<Task>('POST', `/tasks/${encodeURIComponent(id)}/move`, { status, beforeId })
      setState((s) => ({ tasks: upsert(s.tasks, saved) }))
    } catch (e) {
      const current = getState().tasks.find((t) => t.id === id)
      if (current) setState((s) => ({ tasks: upsert(s.tasks, original) }))
      toast(`Не удалось переместить ${id}: ${errorText(e)}`, 'error')
    }
  }

  const sync = async () => {
    setSyncing(true)
    const res = await tryApi<{ imported: number; updated: number }>('POST', '/tasks/sync')
    setSyncing(false)
    if (res) toast(`Синхронизировано: новых ${res.imported}, обновлено ${res.updated}`, 'ok')
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Задача ${active.id} поднята.`,
    onDragOver: ({ active, over }) => (over ? `Задача ${active.id} в колонке «${statusLabel(colOf(shown, String(over.id)) ?? 'todo')}».` : `Задача ${active.id} вне колонок.`),
    onDragEnd: ({ active, over }) => (over ? `Задача ${active.id} перемещена.` : `Задача ${active.id} отпущена на месте.`),
    onDragCancel: ({ active }) => `Перемещение задачи ${active.id} отменено.`,
  }

  const dragged = drag ? byId.get(drag.id) : undefined
  const openTaskObj = openId ? byId.get(openId) : undefined

  return (
    <div className="board-view">
      <header className="view-head">
        <h1>Задачи</h1>
        <span className="count">{tasks.length}</span>
        <span className="grow" />
        <div className="search">
          <Search aria-hidden />
          <input className="input" type="search" placeholder="Поиск задач" aria-label="Поиск задач" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {workspaces.length > 1 && (
          <Select label="Фильтр по репозиторию" value={repo} onChange={setRepo} options={[{ value: '', label: 'Все репозитории' }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))]} />
        )}
        <button type="button" className="btn btn-ghost" aria-pressed={showHidden} onClick={() => setShowHidden(!showHidden)} data-tip="Скрытые с доски задачи">
          {showHidden ? <Eye /> : <EyeOff />}
          Скрытые
        </button>
        {syncEnabled && (
          <button type="button" className="btn" onClick={sync} disabled={syncing}>
            <RefreshCw className={syncing ? 'spinner' : undefined} />
            Синхронизировать
          </button>
        )}
      </header>
      {trackerProblem && (
        <div className="banner" role="status">
          <CloudOff aria-hidden />
          Трекер недоступен: {trackerProblem.error}. Показан снимок от {new Date(trackerProblem.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDrag(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: 'Чтобы переместить задачу, нажмите пробел. Стрелки — перемещение, пробел — отпустить, Escape — отмена.' },
        }}
      >
        <div className="board">
          {COLUMNS.map((c) => (
            <Column key={c.id} status={c.id} label={c.label} ids={shown[c.id]} ctx={ctx} repo={repo} dragging={!!drag} tip={columnTip(c.id, statusMap)} />
          ))}
        </div>
        <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }}>
          {dragged && <div className="card card-overlay"><TaskCard task={dragged} ctx={ctx} /></div>}
        </DragOverlay>
      </DndContext>

      {openTaskObj && <TaskDrawer key={openTaskObj.id} task={openTaskObj} ctx={ctx} onClose={() => setOpenId(null)} />}
    </div>
  )
}

/** What a column means: which tracker statuses land in it, and that moving a card never changes the tracker. */
function columnTip(status: TaskStatus, map: Record<string, string> | undefined) {
  const from = Object.entries(map ?? {}).filter(([, col]) => col === status).map(([ext]) => ext)
  return `Колонка доски.${from.length ? ` Статусы трекера: ${from.join(', ')}.` : ''}\nПеренос карточки не меняет статус в трекере.`
}

function Column({ status, label, ids, ctx, repo, dragging, tip }: { status: TaskStatus; label: string; ids: string[]; ctx: BoardCtx; repo: string; dragging: boolean; tip: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: COL_PREFIX + status })
  const [adding, setAdding] = useState(false)

  return (
    <section className="col" aria-labelledby={`col-${status}`} data-over={isOver}>
      <header className="col-head">
        <span className="col-mark" data-s={status} aria-hidden />
        <h2 id={`col-${status}`} data-tip={tip}>{label}</h2>
        <span className="col-count num">{ids.length}</span>
        <button type="button" className="icon-btn icon-btn-sm" aria-label={`Добавить задачу в «${label}»`} data-tip="Добавить задачу" onClick={() => setAdding(true)}>
          <Plus />
        </button>
      </header>
      {adding && <QuickAdd status={status} repo={repo} onDone={() => setAdding(false)} />}
      <SortableContext id={status} items={ids} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="col-body">
          {ids.map((id) => {
            const t = ctx.byId.get(id)
            return t ? <SortableCard key={id} task={t} ctx={ctx} /> : null
          })}
          {ids.length === 0 && dragging && <div className="col-empty">Перетащите сюда</div>}
        </div>
      </SortableContext>
    </section>
  )
}

const SortableCard = memo(function SortableCard({ task, ctx }: { task: Task; ctx: BoardCtx }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition }
  return (
    <article
      ref={setNodeRef}
      style={style}
      className="card"
      data-placeholder={isDragging}
      data-status={task.status}
      data-hidden={task.hidden}
      {...attributes}
      aria-roledescription="задача"
      aria-label={`${task.id}: ${task.title}`}
      {...listeners}
      onClick={() => ctx.onOpen(task.id)}
    >
      <TaskCard task={task} ctx={ctx} />
    </article>
  )
})

function QuickAdd({ status, repo, onDone }: { status: TaskStatus; repo: string; onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    const t = await tryApi<Task>('POST', '/tasks', { title: title.trim(), status, workspaceId: repo || undefined })
    setBusy(false)
    if (t) {
      setState((s) => ({ tasks: upsert(s.tasks, t) }))
      setTitle('')
    }
  }
  return (
    <div className="quick-add">
      <input
        className="input"
        autoFocus
        placeholder="Название задачи, Enter — добавить"
        aria-label="Название новой задачи"
        value={title}
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') onDone()
        }}
        onBlur={() => { if (!title.trim()) onDone() }}
      />
    </div>
  )
}
