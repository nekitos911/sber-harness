import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { loadDraft, saveDraft } from '../lib/draft'
import { runJob } from '../lib/jobs'
import { Skeleton } from '../components/bits'
import { ReworkPopover } from '../components/board/Rework'
import {
  closestCorners, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors,
  type Announcements, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CloudOff, Columns3, Eye, EyeOff, ListFilter, Plus, RefreshCw, Search, SquareKanban } from 'lucide-react'
import { useMedia } from '../lib/useMedia'
import { api, errorText, tryApi } from '../api'
import { getState, setState, toast, upsert, useFeature, useStore } from '../store'
import { COLUMNS, statusLabel } from '../lib/format'
import { byOrder } from '../lib/tasks'
import type { Task, TaskStatus } from '../types'
import { TaskCard, type BoardCtx } from '../components/board/TaskCard'
import { TaskDrawer } from '../components/board/TaskDrawer'
import { Button, Popover, Segmented, Select } from '../components/ui'
import { TaskList } from '../components/board/TaskList'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { useSettings } from '../lib/agents'

type Cols = Record<TaskStatus, string[]>
const COL_PREFIX = 'col:'

export function BoardView() {
  const tasks = useStore((s) => s.tasks)
  const loaded = useStore((s) => s.loaded)
  const sessions = useStore((s) => s.sessions)
  const workspaces = useStore((s) => s.workspaces)
  const agents = useStore((s) => s.agents)
  const syncEnabled = useStore((s) => s.integrations.tasks)
  const trackerProblem = useStore((s) => s.integrations.tasksProblem)
  const focusTaskId = useStore((s) => s.focusTaskId)
  const settings = useSettings()
  const board = settings?.board
  const notifications = useStore((s) => s.notifications)
  const [allStatuses, setAllStatuses] = useState(false)
  const [trackerSync, setTrackerSync] = useState<Record<string, { text: string; from: string | null; at: number }>>({})
  // Lanes: the team's configured columns; the other semantic statuses only on «Все статусы» (muted).
  const lanes = useMemo(() => {
    const conf = board?.columns?.length ? board.columns : COLUMNS.map((c) => ({ status: c.id, label: c.label, trackerStatuses: [] as string[] }))
    const extra = COLUMNS.filter((c) => !conf.some((x) => x.status === c.id)).map((c) => ({ status: c.id, label: c.label, trackerStatuses: [] as string[], muted: true }))
    return [...conf.map((c) => ({ ...c, muted: false })), ...(allStatuses ? extra : [])]
  }, [board, allStatuses])
  const hiddenStatuses = (board?.columns?.length ?? 5) < 5

  const [query, setQuery] = useState('')
  // «Список · Доска»: the list by default (hand tasks to the agent), the kanban for those who want it
  const [layout, setLayoutState] = useState<'list' | 'board'>(() => loadDraft<'list' | 'board'>('board:layout') ?? 'list')
  const setLayout = (v: 'list' | 'board') => { setLayoutState(v); saveDraft('board:layout', v === 'list' ? null : v) }
  const [repo, setRepo] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ id: string; cols: Cols; from: TaskStatus } | null>(null)
  const reworkOn = useFeature('rework')
  const importOn = useFeature('tracker-import')
  const [importOpen, setImportOpen] = useState(false)
  const narrow = useMedia('(max-width: 1439px)')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filtersRef = useRef<HTMLButtonElement>(null)
  const importRef = useRef<HTMLButtonElement>(null)
  const [creating, setCreating] = useState(false)
  const [reworkDrop, setReworkDrop] = useState<{ id: string; beforeId: string | null; afterId: string | null } | null>(null)
  const dropAnchor = useRef<HTMLElement | null>(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    if (focusTaskId) { setOpenId(focusTaskId); setState({ focusTaskId: null }) }
  }, [focusTaskId])

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])

  useEffect(() => {
    const ids = Object.keys(trackerSync)
    if (!ids.length) return
    let changed = false
    const next = { ...trackerSync }
    for (const id of ids) {
      const t = byId.get(id)
      const p = next[id]
      const note = notifications.find((n) => n.taskId === id && n.at >= p.at && (n.kind === 'error' || n.kind === 'failed' || n.kind === 'info'))
      if (t && t.externalStatus !== p.from && !p.text.endsWith('✓')) { next[id] = { ...p, text: `трекер: ${t.externalStatus} ✓` }; changed = true }
      else if (note && !p.text.endsWith('✓')) { toast(note.text, 'error'); delete next[id]; changed = true }
      else if (Date.now() - p.at > 20_000) { delete next[id]; changed = true }
    }
    if (changed) setTrackerSync(next)
    const t = window.setTimeout(() => setTrackerSync((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => !v.text.endsWith('✓') && Date.now() - v.at < 20_000))), 4000)
    return () => window.clearTimeout(t)
  }, [byId, notifications, trackerSync])
  const ctx = useMemo<BoardCtx>(() => {
    const kids = new Map<string, Task[]>()
    for (const t of tasks) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t])
    return {
      byId, kids,
      sessions: new Map(sessions.map((s) => [s.id, s])),
      workspaces: new Map(workspaces.map((w) => [w.id, w])),
      agents: new Map(agents.map((a) => [a.id, a])),
      onOpen: setOpenId,
      showRepo: !repo && workspaces.length > 1,
      trackerSync,
    }
  }, [tasks, byId, sessions, workspaces, agents, repo, trackerSync])

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
    // Back from testing to work with an agent on it: ask what to fix (or just move).
    if (reworkOn && d.from === 'review' && col === 'in_progress' && getState().sessions.some((x) => x.taskId === id && x.role !== 'reviewer')) {
      dropAnchor.current = document.querySelector<HTMLElement>(`[data-task-id="${window.CSS.escape(id)}"]`)
      setReworkDrop({ id, beforeId, afterId: list[at - 1] ?? null })
      return
    }
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
      // The harness moves the tracker on its own; show it on the card until the tracker status changes or a warning comes.
      if (board?.moveSyncsTracker && original.externalId && status !== original.status) {
        setTrackerSync((m) => ({ ...m, [id]: { text: 'трекер: перевод…', from: original.externalStatus, at: Date.now() } }))
      }
    } catch (e) {
      const current = getState().tasks.find((t) => t.id === id)
      if (current) setState((s) => ({ tasks: upsert(s.tasks, original) }))
      toast(`Не удалось переместить ${id}: ${errorText(e)}`, 'error')
    }
  }

  const sync = async () => {
    setSyncing(true)
    const res = await runJob('Синхронизация с трекером', (jobId) => api<{ imported: number; updated: number }>('POST', '/tasks/sync', undefined, { jobId }))
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

  if (!loaded) return <div className="board-view"><div className="board-loading"><Skeleton rows={8} label="Загрузка задач…" /></div></div>

  // Below 1280 px the filters fold into one «Фильтры» menu.
  const filters = (
    <>
      {workspaces.length > 1 && (
        <Select label="Фильтр по репозиторию" value={repo} onChange={setRepo} options={[{ value: '', label: 'Все репозитории' }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))]} />
      )}
      {hiddenStatuses && (
        <button type="button" className="btn btn-ghost" aria-pressed={allStatuses} onClick={() => setAllStatuses(!allStatuses)} data-tip="Показать статусы вне рабочего процесса (бэклог, готово)">
          <Columns3 />
          Все статусы
        </button>
      )}
      <button type="button" className="btn btn-ghost" aria-pressed={showHidden} onClick={() => setShowHidden(!showHidden)} data-tip="Скрытые с доски задачи">
        {showHidden ? <Eye /> : <EyeOff />}
        Скрытые
      </button>
    </>
  )
  const activeFilters = Number(!!repo) + Number(!!hiddenStatuses && allStatuses) + Number(showHidden)

  return (
    <div className="board-view">
      <header className="view-head">
        <h1>Задачи</h1>
        <span className="count">{tasks.length}</span>
        <Segmented size="sm" label="Вид" value={layout} onChange={setLayout} options={[{ value: 'list', label: 'Список' }, { value: 'board', label: 'Доска' }]} />
        <span className="grow" />
        <div className="search">
          <Search aria-hidden />
          <input className="input" type="search" placeholder="Поиск задач" aria-label="Поиск задач" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {narrow ? (
          <>
            <button ref={filtersRef} type="button" className="btn btn-ghost" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
              <ListFilter />
              Фильтры{activeFilters > 0 && <span className="count">{activeFilters}</span>}
            </button>
            <Popover anchor={filtersRef} open={filtersOpen} onClose={() => setFiltersOpen(false)} placement="bottom-end" label="Фильтры" className="filters-pop">
              <div className="filters-body">{filters}</div>
            </Popover>
          </>
        ) : filters}
        {importOn && (
          <>
            <button ref={importRef} type="button" className="btn" aria-expanded={importOpen} onClick={() => setImportOpen(!importOpen)} data-tip="Добавить задачу из трекера по ключу или ссылке">
              <Plus />
              По ключу
            </button>
            <ImportPopover anchor={importRef} open={importOpen} onClose={() => setImportOpen(false)} onImported={(id) => setOpenId(id)} />
          </>
        )}
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

      <div className="board-area">
      {layout === 'list' && tasks.length > 0 ? (
        <TaskList ids={lanes.flatMap((c) => shown[c.status] ?? [])} byId={byId} sessions={ctx.sessions} onOpen={setOpenId} />
      ) : (
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
        {tasks.length === 0 && (
          <div className="board-empty">
            <SquareKanban className="empty-icon" aria-hidden />
            <p>Здесь появятся задачи, назначенные на вас в трекере{syncEnabled ? ' (кнопка «Синхронизировать»)' : ''}, созданные агентами или добавленные по ключу.</p>
            <div className="row">
              {syncEnabled && <Button icon={<RefreshCw />} busy={syncing} onClick={() => void sync()}>Синхронизировать</Button>}
              {importOn && <Button icon={<Plus />} onClick={() => setImportOpen(true)}>По ключу</Button>}
              <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>Новая задача</Button>
            </div>
          </div>
        )}
        <div className="board">
          {lanes.map((c, i) => (
            <Column key={c.status} create={creating && i === 0} onCreateShown={() => setCreating(false)} status={c.status} label={c.label} ids={shown[c.status]} ctx={ctx} repo={repo} dragging={!!drag} muted={c.muted}
              tip={columnTip(c.trackerStatuses.length ? c.trackerStatuses : Object.entries(settings?.integrations?.tasks?.statusMap ?? {}).filter(([, v]) => v === c.status).map(([k]) => k))} />
          ))}
        </div>
        <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }}>
          {dragged && <div className="card card-overlay"><TaskCard task={dragged} ctx={ctx} /></div>}
        </DragOverlay>
      </DndContext>
      )}

      {reworkDrop && byId.get(reworkDrop.id) && (
        <ReworkPopover task={byId.get(reworkDrop.id)!} anchor={dropAnchor} open onClose={() => setReworkDrop(null)}
          onSent={() => void move(reworkDrop.id, 'in_progress', reworkDrop.beforeId, reworkDrop.afterId)}
          onMoveOnly={() => void move(reworkDrop.id, 'in_progress', reworkDrop.beforeId, reworkDrop.afterId)} />
      )}
      {openTaskObj && <ErrorBoundary area="карточку задачи"><TaskDrawer key={openTaskObj.id} task={openTaskObj} ctx={ctx} onClose={() => setOpenId(null)} /></ErrorBoundary>}
      </div>
    </div>
  )
}

/** «PROJ-1234 или ссылка на задачу» → POST /tasks/import; the imported task opens; errors stay in the popover. */
function ImportPopover({ anchor, open, onClose, onImported }: { anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void; onImported: (id: string) => void }) {
  const [ref, setRef] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const go = async () => {
    if (!ref.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const t = await api<Task>('POST', '/tasks/import', { ref: ref.trim() })
      setState((s) => ({ tasks: upsert(s.tasks, t) }))
      toast(`Добавлена ${t.externalId ?? t.id}: ${t.title}`, 'ok')
      setRef('')
      onClose()
      onImported(t.id)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="bottom-end" label="Добавить по ключу" className="import-pop">
      <form className="import-form" onSubmit={(e) => { e.preventDefault(); void go() }}>
        <input className="input mono" autoFocus aria-label="Ключ или ссылка" placeholder="PROJ-1234 или ссылка на задачу" value={ref}
          onChange={(e) => { setRef(e.target.value); setError(null) }} aria-invalid={!!error} />
        <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!ref.trim()}>Добавить</Button>
      </form>
      {error && <p className="field-error">{error}</p>}
    </Popover>
  )
}

/** What a column means: which tracker statuses land in it, and that moving a card never changes the tracker. */
function columnTip(from: string[]) {
  return `Колонка доски.${from.length ? ` Статусы трекера: ${from.join(', ')}.` : ''}\nПеренос карточки не меняет статус в трекере.`
}

function Column({ status, label, ids, ctx, repo, dragging, tip, muted, create, onCreateShown }: { status: TaskStatus; label: string; ids: string[]; ctx: BoardCtx; repo: string; dragging: boolean; tip: string; muted?: boolean; create?: boolean; onCreateShown?: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: COL_PREFIX + status })
  const [adding, setAdding] = useState(false)
  useEffect(() => { if (create) { setAdding(true); onCreateShown?.() } }, [create, onCreateShown])

  return (
    <section className="col" aria-labelledby={`col-${status}`} data-over={isOver} data-muted={muted || undefined}>
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
      data-task-id={task.id}
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
