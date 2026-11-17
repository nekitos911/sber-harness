import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUpToLine, Ellipsis, GitBranch, ExternalLink, EyeOff, GitMerge, Lock, Pencil, Play, Plus, Send, SquareArrowOutUpRight, Trash2, UserPlus, Wrench, X } from 'lucide-react'
import { api, ApiError, errorText, tryApi } from '../../api'
import { getState, openDialog, openSession, openWorktree, setState, toast, upsert, useFeature, useStore, without, upsertSession } from '../../store'
import { COLUMNS, fullTime, PRIORITY, relTime } from '../../lib/format'
import { isImported, pendingDeps, taskKey } from '../../lib/tasks'
import { useNow } from '../../lib/useNow'
import { loadDraft, saveDraft } from '../../lib/draft'
import type { Session, Task, TaskPort, TaskStatus } from '../../types'
import { Branch, Skeleton, StatusIcon, statusText } from '../bits'
import { Markdown } from '../Markdown'
import { ChipsInput } from '../ChipsInput'
import { Checkbox, Disclosure, IconButton, MenuButton, Segmented, Select, SuggestInput } from '../ui'
import { useSettings } from '../../lib/agents'
import { ReworkPopover, StartPopover } from './Rework'
import { PrChip } from '../PrChip'
import { openPrSettings, usePr } from '../../lib/pr'
import type { BoardCtx } from './TaskCard'

/** Optimistic: the change shows at once; the server's answer settles it, a failure rolls back (with a toast). */
async function patchTask(id: string, fields: Partial<Task> & { comment?: string }) {
  const before = getState().tasks.find((t) => t.id === id)
  const { comment: _c, ...shown } = fields
  if (before) setState((s) => ({ tasks: upsert(s.tasks, { ...before, ...shown }) }))
  const t = await tryApi<Task>('PATCH', `/tasks/${encodeURIComponent(id)}`, fields)
  if (t) setState((s) => ({ tasks: upsert(s.tasks, t) }))
  else if (before) setState((s) => ({ tasks: upsert(s.tasks, before) }))
  return t
}

/**
 * Local edit buffer that follows the server value until the user starts typing. Typed text is also kept in
 * localStorage under `key` until it is saved (the server value changes) or typed back, so a reload loses nothing.
 */
function useDraft(value: string, key: string) {
  const [draft, setDraftState] = useState(() => loadDraft<string>(key) ?? value)
  const prev = useRef(value)
  useEffect(() => {
    if (prev.current === value) return
    prev.current = value
    setDraftState(value)
    saveDraft(key, null)
  }, [value, key])
  const set = (v: string) => {
    setDraftState(v)
    saveDraft(key, v === value ? null : v)
  }
  return [draft, set] as const
}

export function TaskDrawer({ task, ctx, onClose }: { task: Task; ctx: BoardCtx; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null)
  const titleId = useId()
  const trackerOn = useStore((s) => s.integrations.tasks)
  const [panel, setPanel] = useState<'assign' | 'send' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => { ref.current?.focus() }, [])
  useEffect(() => {
    // Esc closes the drawer unless a modal on top of it (start/PR dialog) is handling it.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const key = taskKey(task, ctx.byId)
  const parent = task.parentId ? ctx.byId.get(task.parentId) : undefined
  const session = task.assigneeSessionId ? ctx.sessions.get(task.assigneeSessionId) : undefined
  const blocked = pendingDeps(task, ctx.byId)
  const reworkOn = useFeature('rework')
  const reworkable = reworkOn && !!session && (session.status !== 'running' || task.status === 'review')
  // Subtasks go through the full dialog (it plans the coordinator); the popover covers the rest, «Где» included.
  const needsDialog = !!ctx.kids.get(task.id)?.length
  const [pop, setPop] = useState<'start' | 'rework' | null>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const patch = (fields: Partial<Task>) => patchTask(task.id, fields)

  const imported = isImported(task)
  // Imported tasks are only hidden by DELETE (re-import keeps them hidden); local ones are deleted.
  const remove = async () => {
    const ok = await tryApi<unknown>('DELETE', `/tasks/${encodeURIComponent(task.id)}`)
    if (ok === undefined) return
    setState((s) => ({ tasks: imported ? upsert(s.tasks, { ...task, hidden: true }) : without(s.tasks, task.id) }))
    onClose()
  }

  return (
    <aside ref={ref} className="drawer" role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1}>
      <header className="drawer-head">
        <span className="mono card-id" data-tip={task.id}>{task.parentId ? `${key} · ${task.id}` : key}</span>
        {task.externalUrl && (
          <a className="icon-btn icon-btn-sm" href={task.externalUrl} target="_blank" rel="noreferrer noopener" aria-label="Открыть в трекере" data-tip="Открыть в трекере">
            <ExternalLink />
          </a>
        )}
        <span className="grow" />
        <span className="muted" data-tip={`обновлено ${fullTime(task.updatedAt)}`}>
          {task.takenAt ? `в работе с ${relTime(task.takenAt)}` : `обновлено ${relTime(task.updatedAt)}`}
        </span>
        <MenuButton label="Ещё действия" icon={<Ellipsis />} align="right" items={[
          { label: 'Назначить агенту…', icon: <UserPlus />, onSelect: () => setPanel('assign') },
          { label: 'Отправить в сессию…', icon: <Send />, onSelect: () => setPanel('send') },
          ...(!task.hidden ? [{ label: imported ? 'Скрыть с доски' : 'Удалить задачу', icon: imported ? <EyeOff /> : <Trash2 />, danger: !imported, divider: true, onSelect: () => setConfirmDelete(true) }] : []),
        ]} />
        <button type="button" className="icon-btn" aria-label="Закрыть" data-tip="Закрыть (Esc)" onClick={onClose}><X /></button>
      </header>

      <div className="drawer-body">
        {parent && (
          <button type="button" className="drawer-parent" onClick={() => ctx.onOpen(parent.id)}>
            Подзадача <span className="mono">{parent.id}</span> <span className="ellipsis">{parent.title}</span>
          </button>
        )}
        <TitleField id={titleId} task={task} />
        {task.hidden && (
          <div className="drawer-note">
            Задача скрыта с доски.
            <button type="button" className="btn btn-sm" onClick={() => void patch({ hidden: false })}>Вернуть на доску</button>
          </div>
        )}
        {task.snapshot && (task.snapshot.title !== task.title || task.snapshot.description !== task.description) && (
          <div className="drawer-note" data-tip={task.snapshot.title}>
            После взятия в работу задача изменилась в трекере (снимок от {fullTime(task.snapshot.at)}).
          </div>
        )}

        <div className="drawer-actions">
          {/* One primary action: take into work → open the running session → send back for rework once it finished. */}
          {!session ? (
            <button ref={primaryRef} type="button" className="btn btn-primary" disabled={blocked.length > 0} data-tip={blocked.length ? `Ждёт: ${blocked.join(', ')}` : undefined}
              onClick={() => (needsDialog ? openDialog({ kind: 'start', taskId: task.id }) : setPop('start'))}>
              <Play />
              Взять в работу
            </button>
          ) : reworkable ? (
            <>
              <button ref={primaryRef} type="button" className="btn btn-primary" onClick={() => setPop('rework')}>
                <Wrench />
                Доработать
              </button>
              <button type="button" className="btn" onClick={() => openSession(session.id)}>
                <StatusIcon session={session} />
                Открыть сессию
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => openSession(session.id)}>
              <StatusIcon session={session} />
              Открыть сессию
            </button>
          )}
          {!session && <StartPopover task={task} anchor={primaryRef} open={pop === 'start'} onClose={() => setPop(null)} />}
          {reworkable && <ReworkPopover task={task} anchor={primaryRef} open={pop === 'rework'} onClose={() => setPop(null)} />}
          <span className="grow" />
          <Select size="sm" className="chip-select" label="Статус" value={task.status} onChange={(v) => void patch({ status: v as TaskStatus })} options={COLUMNS.map((c) => ({ value: c.id, label: c.label }))} />
          <Select size="sm" className="chip-select" label="Приоритет" value={task.priority ?? ''} onChange={(v) => void patch({ priority: (v || null) as Task['priority'] })}
            options={[{ value: '', label: 'Без приоритета' }, ...(['high', 'medium', 'low'] as const).map((p) => ({ value: p, label: PRIORITY[p] }))]} />
        </div>
        {confirmDelete && (
          <div className="drawer-note drawer-confirm">
            <span>{imported ? `Скрыть ${key} с доски? В трекере задача останется.` : `Удалить ${task.id} без возможности восстановления?`}</span>
            <button type="button" className={imported ? 'btn btn-sm' : 'btn btn-sm btn-danger'} onClick={() => void remove()}>{imported ? 'Скрыть' : 'Удалить'}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmDelete(false)}>Отмена</button>
          </div>
        )}
        {panel === 'assign' && <AssignForm task={task} onDone={() => setPanel(null)} />}
        {panel === 'send' && <SendForm task={task} onDone={() => setPanel(null)} />}
        {session && (
          <p className="drawer-assignee">
            <StatusIcon session={session} /> {session.title} · {ctx.agents.get(session.agent)?.label ?? session.agent} · {statusText(session)}
          </p>
        )}

        <WorkSummary task={task} />
        <TaskWorktrees task={task} />

        {imported && <ExternalCard task={task} full={!task.description.trim()} />}
        {imported ? (task.description.trim() && <div className="md-preview drawer-desc"><Markdown text={task.description} /></div>) : <DescriptionField task={task} />}
        {trackerOn && task.externalId && <TrackerStatus task={task} />}
        <TaskPrs task={task} />
        {task.targets.length > 1 && <Ports task={task} />}
        {(ctx.kids.get(task.id)?.length ?? 0) > 0 && <Subtasks task={task} ctx={ctx} />}
        <Disclosure className="drawer-more" summary={<h3>Ещё: зависимости, метки, подзадачи</h3>}>
          <div className="props">
            <Prop label="Зависимости"><DepsField task={task} ctx={ctx} onChange={(deps) => void patch({ deps })} /></Prop>
            <Prop label="Метки"><ChipsInput values={task.labels} label="метку" onChange={(labels) => void patch({ labels })} /></Prop>
          </div>
          {!(ctx.kids.get(task.id)?.length) && <Subtasks task={task} ctx={ctx} />}
        </Disclosure>
        <Activity task={task} sessions={ctx.sessions} />

      </div>
    </aside>
  )
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="prop-label">{label}</span>
      <div className="prop-value">{children}</div>
    </>
  )
}

function TitleField({ id, task }: { id: string; task: Task }) {
  const [v, setV] = useDraft(task.title, `task:${task.id}:title`)
  const save = () => { if (v.trim() && v !== task.title) void patchTask(task.id, { title: v.trim() }) }
  return (
    <textarea
      id={id}
      className="drawer-title"
      aria-label="Название задачи"
      rows={1}
      value={v}
      onChange={(e) => setV(e.target.value.replace(/\n/g, ' '))}
      onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
      ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }}
    />
  )
}

function BranchField({ task }: { task: Task }) {
  const [v, setV] = useDraft(task.branch ?? '', `task:${task.id}:branch`)
  return (
    <input
      className="input mono"
      placeholder="создаётся при запуске"
      aria-label="Рабочая ветка задачи"
      data-tip={task.branch ?? undefined}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v.trim() !== (task.branch ?? '')) void patchTask(task.id, { branch: v.trim() || null }) }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
    />
  )
}

/** Local task description: rendered; a click turns it into the editor, leaving it saves. */
function DescriptionField({ task }: { task: Task }) {
  const [v, setV] = useDraft(task.description, `task:${task.id}:description`)
  const [edit, setEdit] = useState(v !== task.description) // an unsaved draft reopens in the editor (unfocused: no blur-save)
  const [focus, setFocus] = useState(false)
  return edit ? (
    <textarea
      className="textarea"
      rows={8}
      autoFocus={focus}
      aria-label="Описание задачи (markdown)"
      placeholder="Что сделать, критерии готовности, ссылки. Поддерживается markdown."
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { setEdit(false); if (v !== task.description) void patchTask(task.id, { description: v }) }}
    />
  ) : (
    <button type="button" className="md-preview drawer-desc drawer-desc-edit" onClick={() => { setEdit(true); setFocus(true) }} data-tip="Нажмите, чтобы изменить">
      {v.trim() ? <Markdown text={v} /> : <span className="muted">Добавить описание…</span>}
    </button>
  )
}

/**
 * Where the work happens, as one line: repository · base → branch · agent. The values fill themselves
 * (task repo or the only one, targets, branch from the template, default agent); the pencil opens the fields.
 */
function WorkSummary({ task }: { task: Task }) {
  const workspaces = useStore((s) => s.workspaces)
  const agents = useStore((s) => s.agents)
  const defaultAgent = useStore((s) => s.defaultAgent)
  const settings = useSettings()
  const tasks = useStore((s) => s.tasks)
  const [open, setOpen] = useState(false)
  // Only the task's own repository is shown as its repository: a guess is not a choice.
  const repo = workspaces.find((w) => w.id === task.workspaceId)
  const key = taskKey(task, new Map(tasks.map((t) => [t.id, t])))
  const branch = task.branch ?? (settings?.git.branchTemplate || 'feature/{key}').replaceAll('{key}', key)
  const agent = agents.find((a) => a.id === defaultAgent)?.label ?? defaultAgent ?? ''
  const patch = (fields: Partial<Task>) => patchTask(task.id, fields)
  return (
    <div className="work-summary">
      <div className="work-line">
        <span>{repo ? repo.name : <span className="muted">{task.worktrees?.length ? 'по рабочим деревьям ниже' : 'не выбран (агент решит)'}</span>}</span>
        <span className="muted">·</span>
        <span className="mono">{task.targets[0] ?? 'develop'}{task.targets.length > 1 && <span className="muted"> +{task.targets.length - 1}</span>}</span>
        <span className="muted">→</span>
        <span className="mono" data-tip={task.branch ? undefined : 'создастся при запуске'}>{branch}</span>
        {agent && <><span className="muted">·</span><span>{agent}</span></>}
        <IconButton size="sm" label={open ? 'Скрыть поля' : 'Изменить репозиторий и ветки'} icon={<Pencil />} onClick={() => setOpen(!open)} aria-expanded={open} />
      </div>
      <div className="collapse" data-open={open}>
        <div>
          {open && (
            <div className="props work-fields">
              <Prop label="Репозиторий">
                <Select label="Репозиторий" value={task.workspaceId ?? ''} onChange={(v) => void patch({ workspaceId: v || null })}
                  options={[{ value: '', label: 'Не выбран (агент решит)' }, ...workspaces.filter((w) => w.kind !== 'root' && w.kind !== 'folder').map((w) => ({ value: w.id, label: w.name, hint: task.suggestedWorkspace?.id === w.id ? (task.suggestedWorkspace.reason ?? 'возможно') : undefined }))]} />
              </Prop>
              <Prop label="Целевые ветки"><TargetsField task={task} onChange={(targets) => void patch({ targets })} /></Prop>
              <Prop label="Ветка"><BranchField task={task} /></Prop>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** «Рабочие деревья задачи»: where the work is (also those the agent created itself): repo · branch · changes. */
function TaskWorktrees({ task }: { task: Task }) {
  const workspaces = useStore((s) => s.workspaces)
  const list = task.worktrees ?? []
  if (!list.length) return null
  return (
    <section className="drawer-section">
      <h3>Рабочие деревья задачи</h3>
      <ul className="task-wts">
        {list.map((w) => (
          <li key={w.path}>
            <button type="button" className="task-wt" onClick={() => openWorktree(w.path)} data-tip={w.path}>
              <GitBranch aria-hidden />
              <span>{workspaces.find((x) => x.id === w.workspaceId)?.name ?? w.path.split(/[\\/]/).slice(-2, -1)[0]}</span>
              <span className="mono muted ellipsis">{w.branch ?? ''}</span>
              {(w.dirty ?? 0) > 0 && <span className="wt-stat num">±{w.dirty}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function TargetsField({ task, onChange }: { task: Task; onChange: (t: string[]) => void }) {
  const allTasks = useStore((s) => s.tasks)
  const [v, setV] = useState('')
  // Team branches: develop, release/1.54.0; typing "rel" offers the release/ prefix.
  const known = useMemo(() => [...new Set(['develop', 'main', 'release/', ...allTasks.flatMap((t) => t.targets)])], [allTasks])
  const targets = task.targets
  const add = () => {
    const t = v.trim()
    if (!t || targets.includes(t)) return
    onChange([...targets, t])
    setV('')
  }
  return (
    <div className="targets">
      <div className="chips">
        {targets.map((t, i) => (
          <span key={t} className={i === 0 ? 'chip chip-mono chip-primary' : 'chip chip-mono'} data-tip={i === 0 ? 'Основная: здесь делается работа' : 'Портируется cherry-pick'}>
            {i > 0 && <GitMerge aria-hidden />}
            {t}
            {i > 0 && (
              <button type="button" className="chip-x" aria-label={`Сделать ${t} основной`} data-tip="Сделать основной" onClick={() => onChange([t, ...targets.filter((x) => x !== t)])}>
                <ArrowUpToLine />
              </button>
            )}
            <button type="button" className="chip-x" aria-label={`Убрать ${t}`} onClick={() => onChange(targets.filter((x) => x !== t))}>
              <X />
            </button>
          </span>
        ))}
      </div>
      <div className="row">
        <SuggestInput
          mono
          label="Добавить целевую ветку"
          placeholder="develop или release/1.54.0, Enter — добавить"
          value={v}
          onChange={setV}
          onEnter={() => add()}
          suggestions={known.filter((k) => !targets.includes(k))}
        />
        <button type="button" className="btn btn-sm" onClick={() => setV('release/')} data-tip="Добавить релизную ветку">
          release/…
        </button>
      </div>
      <p className="field-hint">Первая — где делается работа, остальные — куда портируется cherry-pick'ом.</p>
    </div>
  )
}

function DepsField({ task, ctx, onChange }: { task: Task; ctx: BoardCtx; onChange: (d: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = (id: string) => onChange(task.deps.includes(id) ? task.deps.filter((d) => d !== id) : [...task.deps, id])
  const needle = q.trim().toLowerCase()
  const options = [...ctx.byId.values()].filter((t) => t.id !== task.id && (!needle || `${t.id} ${t.title}`.toLowerCase().includes(needle)))

  return (
    <div className="deps" ref={box}>
      <div className="chips">
        {task.deps.map((d) => {
          const dep = ctx.byId.get(d)
          const waiting = dep && dep.status !== 'done'
          return (
            <span key={d} className={waiting ? 'chip chip-fail' : 'chip chip-done'} data-tip={dep ? `${dep.title} — ${COLUMNS.find((c) => c.id === dep.status)?.label}` : 'задача удалена'}>
              {waiting && <Lock aria-hidden />}
              <button type="button" className="chip-link mono" onClick={() => dep && ctx.onOpen(d)}>{d}</button>
              <button type="button" className="chip-x" aria-label={`Убрать зависимость ${d}`} onClick={() => toggle(d)}><X /></button>
            </span>
          )
        })}
        <button type="button" className="chip" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Plus aria-hidden />
          добавить
        </button>
      </div>
      {open && (
        <div
          className="menu deps-menu"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false) } }}
        >
          <input className="input" autoFocus placeholder="Поиск задачи" aria-label="Поиск задачи" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="deps-list">
            {options.map((t) => (
              <div key={t.id} className="deps-option">
                <Checkbox checked={task.deps.includes(t.id)} onChange={() => toggle(t.id)}>
                  <span className="mono muted">{t.id}</span> {t.title}
                </Checkbox>
              </div>
            ))}
            {options.length === 0 && <p className="muted" style={{ padding: 8 }}>Нет задач</p>}
          </div>
        </div>
      )}
    </div>
  )
}

interface Transitions { current: string; transitions: { id: string; label: string }[] }

/**
 * Changing the tracker status is explicit; moving the card never touches the tracker.
 * Newer servers list the allowed transitions; older ones take a free-text status.
 */
function TrackerStatus({ task }: { task: Task }) {
  const tasks = useStore((s) => s.tasks)
  const known = useMemo(() => [...new Set(tasks.map((t) => t.externalStatus).filter((x): x is string => !!x))], [tasks])
  const [list, setList] = useState<Transitions | null | 'loading'>('loading')
  const [status, setStatus] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    api<Transitions>('GET', `/tasks/${encodeURIComponent(task.id)}/transitions`).then(
      (r) => { if (live) setList(r?.transitions ? r : null) },
      () => { if (live) setList(null) }, // not supported here: free-text status below
    )
    return () => { live = false }
  }, [task.id, task.externalStatus])

  const transitions = list && list !== 'loading' ? list.transitions : null
  const label = transitions?.find((t) => t.id === status)?.label ?? status.trim()
  const submit = async () => {
    setBusy(true)
    const body = transitions ? { transition: status, comment: comment.trim() || undefined } : { status: status.trim(), comment: comment.trim() || undefined }
    const res = await tryApi<Task | { ok: true }>('POST', `/tasks/${encodeURIComponent(task.id)}/tracker-status`, body)
    setBusy(false)
    if (res === undefined) return
    if (res && 'id' in res) setState((s) => ({ tasks: upsert(s.tasks, res) }))
    toast(`Статус в трекере: ${label}`, 'ok')
    setStatus('')
    setComment('')
  }
  const current = (list && list !== 'loading' ? list.current : null) ?? task.externalStatus ?? 'неизвестен'
  return (
    <section className="drawer-section">
      <h3>Статус в трекере <span className="chip chip-mono">{current}</span></h3>
      <p className="field-hint">Перемещение карточки по доске не меняет статус в трекере, только эта форма.</p>
      <div className="tracker-form">
        {list === 'loading' ? (
          <Skeleton rows={1} label="Загрузка переходов…" />
        ) : transitions ? (
          <Select label="Переход в трекере" value={status} onChange={setStatus} disabled={!transitions.length}
            placeholder={transitions.length ? 'Выберите переход…' : 'Нет доступных переходов'}
            options={transitions.map((t) => ({ value: t.id, label: t.label }))} />
        ) : (
          <>
            <SuggestInput label="Новый статус в трекере" placeholder="Новый статус" value={status} onChange={setStatus} suggestions={known} />
          </>
        )}
        <button type="button" className="btn" disabled={!status.trim() || busy} onClick={() => void submit()}>{busy ? 'Меняем…' : 'Изменить в трекере'}</button>
        <textarea className="textarea" rows={2} placeholder="Комментарий (необязательно)" aria-label="Комментарий к смене статуса" value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>
    </section>
  )
}

interface External { fields: Record<string, unknown>; description: string; links?: { type: string; from: string; to: string }[] }

/** An imported task without a description: read the card from the tracker on open (newer servers). */
function ExternalCard({ task, full }: { task: Task; full: boolean }) {
  const [card, setCard] = useState<External | 'loading' | { error: string }>('loading')
  useEffect(() => {
    let live = true
    api<External>('GET', `/tasks/${encodeURIComponent(task.id)}/external`).then(
      (r) => { if (live) setCard(r) },
      (e) => { if (live) setCard(e instanceof ApiError && e.status === 404 ? { error: '' } : { error: errorText(e) }) },
    )
    return () => { live = false }
  }, [task.id])
  if (card !== 'loading' && 'error' in card && !card.error) return null // endpoint absent on this server
  // With a description already on the card only the links matter; fetch quietly and show nothing until they come.
  if (!full) return card !== 'loading' && !('error' in card) && card.links?.length ? <section className="drawer-section"><TrackerLinks task={task} links={card.links} /></section> : null
  const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v === null || v === undefined || v === '' ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  return (
    <section className="drawer-section">
      <h3>Из трекера</h3>
      {card === 'loading' ? <Skeleton rows={4} label="Загрузка карточки из трекера…" /> : 'error' in card ? (
        <p className="field-error">Не удалось загрузить карточку: {card.error}</p>
      ) : (
        <>
          <div className="props">
            {Object.entries(card.fields).filter(([, v]) => show(v)).map(([k, v]) => (
              <Prop key={k} label={k}><span className="prop-text">{show(v)}</span></Prop>
            ))}
          </div>
          {card.description.trim() && <div className="md-preview"><Markdown text={card.description} /></div>}
          {!!card.links?.length && <TrackerLinks task={task} links={card.links} />}
        </>
      )}
    </section>
  )
}

/** «Связи» from the tracker: decomposition children first (with titles when they are on the board), then the rest. */
function TrackerLinks({ task, links }: { task: Task; links: NonNullable<External['links']> }) {
  const tasks = useStore((s) => s.tasks)
  const linksOn = useFeature('tracker-links')
  const [busy, setBusy] = useState(false)
  const me = task.externalId
  const kids = links.filter((l) => /decompos/i.test(l.type) && l.from === me).map((l) => l.to)
  const other = links.filter((l) => !(/decompos/i.test(l.type) && l.from === me))
  const onBoard = (key: string) => tasks.find((t) => t.externalId === key)
  const missing = kids.filter((k) => !onBoard(k))
  const importKids = async () => {
    setBusy(true)
    const r = await tryApi<{ imported: number; updated: number }>('POST', `/tasks/${encodeURIComponent(task.id)}/import-children`)
    setBusy(false)
    if (r) toast(`Подзадачи: новых ${r.imported}, обновлено ${r.updated}`, 'ok')
  }
  return (
    <div className="tracker-links">
      <h4>Связи</h4>
      {kids.map((k) => {
        const t = onBoard(k)
        return (
          <div key={k} className="link-row">
            <span className="chip chip-mono">{k}</span>
            <span className={t ? 'ellipsis' : 'muted'}>{t ? t.title : 'ещё не на доске'}</span>
            <span className="muted">подзадача</span>
          </div>
        )
      })}
      {other.map((l, i) => (
        <div key={`${l.type}-${i}`} className="link-row">
          <span className="chip chip-mono">{l.from === me ? l.to : l.from}</span>
          <span className="ellipsis">{onBoard(l.from === me ? l.to : l.from)?.title ?? ''}</span>
          <span className="muted">{l.type}</span>
        </div>
      ))}
      {missing.length > 0 && linksOn && (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void importKids()}>{busy ? 'Добавляем…' : `Добавить подзадачи на доску (${missing.length})`}</button>
      )}
    </div>
  )
}

const PORT_STATUS: Record<TaskPort['status'], { label: string; cls: string }> = {
  clean: { label: 'перенесено', cls: 'chip chip-done' },
  conflict: { label: 'конфликт', cls: 'chip chip-run' },
  done: { label: 'готово', cls: 'chip chip-done' },
  failed: { label: 'ошибка', cls: 'chip chip-fail' },
}

function Ports({ task }: { task: Task }) {
  const [busy, setBusy] = useState<string | null>(null)
  const port = async (target: string) => {
    setBusy(target)
    const res = await tryApi<TaskPort>('POST', `/tasks/${encodeURIComponent(task.id)}/port`, { target })
    setBusy(null)
    if (!res) return
    if (res.status === 'conflict') toast(`Конфликт при переносе в ${target} — агент разбирается`, 'info')
    else toast(`Перенесено в ${target}`, 'ok')
    if (res.sessionId) openSession(res.sessionId)
  }
  return (
    <section className="drawer-section">
      <h3>Портирование</h3>
      {!task.branch && <p className="field-hint">Сначала нужна рабочая ветка: возьмите задачу в работу.</p>}
      <div className="ports">
        {task.targets.slice(1).map((target) => {
          const p = task.ports.find((x) => x.target === target)
          return (
            <div key={target} className="port-row">
              <GitMerge aria-hidden />
              <span className="mono ellipsis" data-tip={target}>{target}</span>
              {p ? <span className={PORT_STATUS[p.status].cls}>{PORT_STATUS[p.status].label}</span> : <span className="chip">не перенесено</span>}
              <span className="grow" />
              {p?.sessionId && (
                <button type="button" className="icon-btn icon-btn-sm" aria-label="Открыть сессию портирования" data-tip="Открыть сессию" onClick={() => openSession(p.sessionId!)}>
                  <SquareArrowOutUpRight />
                </button>
              )}
              {(!p || p.status === 'failed') && (
                <button type="button" className="btn btn-sm" disabled={!task.branch || busy !== null} onClick={() => void port(target)}>
                  {busy === target ? 'Переносим…' : `Портировать в ${target}`}
                </button>
              )}
              {p && <span className="port-branch"><Branch name={p.branch} /></span>}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Subtasks({ task, ctx }: { task: Task; ctx: BoardCtx }) {
  const workspaces = useStore((s) => s.workspaces)
  const kids = ctx.kids.get(task.id) ?? []
  const done = kids.filter((k) => k.status === 'done').length
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [repo, setRepo] = useState(task.workspaceId ?? '')

  const add = async () => {
    if (!title.trim()) return
    const t = await tryApi<Task>('POST', '/tasks', { title: title.trim(), parentId: task.id, workspaceId: repo || undefined })
    if (!t) return
    setState((s) => ({ tasks: upsert(s.tasks, t) }))
    setTitle('')
  }

  return (
    <section className="drawer-section">
      <h3>
        Подзадачи
        {kids.length > 0 && <span className="muted num" style={{ fontWeight: 400 }}>{done}/{kids.length}</span>}
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setAdding(!adding)} aria-expanded={adding}>
          <Plus />
          Добавить подзадачу
        </button>
      </h3>
      {kids.length > 0 && (
        <>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={kids.length} aria-valuenow={done} aria-label="Готово подзадач">
            <span style={{ transform: `scaleX(${done / kids.length})` }} />
          </div>
          <div>
            {kids.map((k) => (
              <button key={k.id} type="button" className="subtask" onClick={() => ctx.onOpen(k.id)}>
                <span className="col-mark" data-s={k.status} aria-label={COLUMNS.find((c) => c.id === k.status)?.label} />
                <span className="mono muted">{k.id}</span>
                <span className="ellipsis grow">{k.title}</span>
                {k.workspaceId && <span className="chip">{ctx.workspaces.get(k.workspaceId)?.name ?? k.workspaceId}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      {kids.length === 0 && !adding && <p className="field-hint">Одна подзадача на репозиторий, если спецификация затрагивает несколько сервисов.</p>}
      {adding && (
        <form className="subtask-form" onSubmit={(e) => { e.preventDefault(); void add() }}>
          <input className="input" autoFocus placeholder="Название подзадачи" aria-label="Название подзадачи" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Select label="Репозиторий подзадачи" value={repo} onChange={setRepo} placeholder="Репозиторий…" options={workspaces.map((w) => ({ value: w.id, label: w.name }))} />
          <button type="submit" className="btn btn-sm" disabled={!title.trim()}>Добавить</button>
        </form>
      )}
    </section>
  )
}

function Activity({ task, sessions }: { task: Task; sessions: Map<string, Session> }) {
  const now = useNow()
  const log = task.log.filter((l) => typeof l.text === 'string' && l.text.trim()) // technical entries without text stay hidden
  if (!log.length) return null
  const who = (by: string) => (by === 'user' ? 'вы' : by === 'harness' ? 'harness' : sessions.get(by)?.title ?? by)
  return (
    <Disclosure className="drawer-more" summary={<h3>Журнал <span className="muted num">{log.length}</span></h3>}>
      <ol className="activity">
        {log.map((l, i) => (
          <li key={i}>
            <span className="muted" data-tip={fullTime(l.at)}>{relTime(l.at, now)}</span>
            <span className="activity-by">{who(l.by)}</span>
            <span className="activity-text">{l.text}</span>
          </li>
        ))}
      </ol>
    </Disclosure>
  )
}

function AssignForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const agents = useStore((s) => s.agents)
  const workspaces = useStore((s) => s.workspaces)
  const enabled = agents.filter((a) => a.enabled)
  const [agent, setAgent] = useState(enabled[0]?.id ?? '')
  const [worktree, setWorktree] = useState<'new' | 'current'>('new')
  const [repo, setRepo] = useState(task.workspaceId ?? workspaces[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    const s = await tryApi<Session>('POST', `/tasks/${encodeURIComponent(task.id)}/assign`, { agent, workspaceId: repo || undefined, worktree })
    setBusy(false)
    if (!s) return
    setState((st) => ({ sessions: upsertSession(st.sessions, s) }))
    onDone()
    openSession(s.id)
  }
  return (
    <div className="drawer-form">
      <label className="field">
        <span>Агент</span>
        <Select label="Агент" value={agent} onChange={setAgent} options={enabled.map((a) => ({ value: a.id, label: a.label }))} />
      </label>
      <label className="field">
        <span>Репозиторий</span>
        <Select label="Репозиторий" value={repo} onChange={setRepo} options={workspaces.map((w) => ({ value: w.id, label: w.name }))} />
      </label>
      <div className="field">
        <span>Рабочая копия</span>
        <Segmented label="Рабочая копия" value={worktree} onChange={setWorktree} options={[{ value: 'new', label: 'Новая ветка' }, { value: 'current', label: 'Текущая' }]} />
      </div>
      <button type="button" className="btn btn-primary" disabled={!agent || busy} onClick={() => void submit()}>
        {busy ? 'Запуск…' : 'Назначить'}
      </button>
    </div>
  )
}

function SendForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const sessions = useStore((s) => s.sessions)
  const chats = sessions.filter((s) => s.kind === 'chat')
  const [target, setTarget] = useState(chats[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  if (!chats.length) return <p className="field-hint drawer-form">Нет чатов. Создайте чат или назначьте задачу агенту.</p>
  const submit = async () => {
    setBusy(true)
    const s = await tryApi<Session>('POST', `/tasks/${encodeURIComponent(task.id)}/assign`, { sessionId: target })
    setBusy(false)
    if (!s) return
    onDone()
    openSession(s.id)
  }
  return (
    <div className="drawer-form">
      <label className="field" style={{ gridColumn: '1 / -1' }}>
        <span>Чат</span>
        <Select label="Чат" value={target} onChange={setTarget} options={chats.map((c) => ({ value: c.id, label: c.title, hint: statusText(c) }))} />
      </label>
      <button type="button" className="btn btn-primary" disabled={!target || busy} onClick={() => void submit()}>
        {busy ? 'Отправка…' : 'Отправить задачу'}
      </button>
    </div>
  )
}

/** «Пулл-реквесты»: one row per target branch (the task branch into targets[0], each port into its target). */
function TaskPrs({ task }: { task: Task }) {
  const enabled = useStore((s) => s.integrations.pr)
  const sessions = useStore((s) => s.sessions)
  const worktrees = useStore((s) => s.worktrees)
  if (!task.targets.length) return null
  // Where task.branch is checked out: the assignee's folder, else a worktree on that branch.
  const assignee = sessions.find((x) => x.id === task.assigneeSessionId)
  const mainCwd = assignee?.cwd ?? Object.values(worktrees).flat().find((w) => task.branch && w.branch === task.branch)?.path ?? null
  return (
    <section className="drawer-section">
      <h3>Пулл-реквесты</h3>
      {!enabled ? (
        <div className="pr-off"><span className="muted">PR-интеграция не настроена.</span><button type="button" className="btn btn-sm" onClick={openPrSettings}>Настроить</button></div>
      ) : (
        <div className="ports">
          <PrRow target={task.targets[0]} cwd={mainCwd} branch={task.branch} known={task.pr ?? null} />
          {task.ports.map((p) => <PrRow key={p.target} target={p.target} cwd={p.cwd} branch={p.branch} known={null} />)}
        </div>
      )}
    </section>
  )
}

function PrRow({ target, cwd, branch, known }: { target: string; cwd: string | null; branch: string | null; known: Task['pr'] }) {
  const pr = usePr(cwd)
  const live = pr && typeof pr === 'object' && !('error' in pr) ? pr : null
  const shown = live ?? known
  return (
    <div className="port-row">
      <GitMerge aria-hidden />
      <span className="mono ellipsis" data-tip={`${branch ?? '—'} → ${target}`}>{target}</span>
      <span className="grow" />
      {shown ? <PrChip pr={shown} /> : !cwd || !branch ? (
        <span className="muted">ветки ещё нет: возьмите задачу в работу</span>
      ) : pr === undefined ? (
        <span className="muted">проверяем…</span>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => openDialog({ kind: 'pr', cwd, base: target })}>Создать PR в {target}</button>
      )}
    </div>
  )
}
