import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Bot, Ellipsis, GitBranch, ExternalLink, EyeOff, GitMerge, History, Lock, Pencil, Play, Plus, Send, Settings2, SquareArrowOutUpRight, Trash2, User, UserPlus, Wrench, X } from 'lucide-react'
import { api, ApiError, errorText, tryApi } from '../../api'
import { closeDetail, getState, openDialog, openSession, openWorktree, setState, toast, upsert, useFeature, useStore, without, upsertSession } from '../../store'
import { COLUMNS, fullTime, PRIORITY, relTime, statusLabel } from '../../lib/format'
import { isImported, pendingDeps, taskKey } from '../../lib/tasks'
import { useNow } from '../../lib/useNow'
import { loadDraft, saveDraft } from '../../lib/draft'
import type { Session, Task, TaskPort, TaskStatus } from '../../types'
import { Branch, Skeleton, StatusIcon, statusText } from '../bits'
import { Markdown } from '../Markdown'
import { ChipsInput } from '../ChipsInput'
import { Checkbox, Disclosure, IconButton, MenuButton, Segmented, Select, SuggestInput } from '../ui'
import { useSettings } from '../../lib/agents'
import { HandoffPopover, ReworkPopover, StartPopover } from './Rework'
import { TargetsLine } from '../ReleaseTargets'
import { PrChip } from '../PrChip'
import { openPrSettings, usePr } from '../../lib/pr'
import { AgentBadge, chipChat, type BoardCtx } from './TaskCard'
import { agentChip, chipStates } from '../../lib/agentChip'
import { dur, sessionVisualState } from '../../lib/sessionState'
import { DetailBar, Meta } from '../DetailPage'

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

/** One task as a page over «Задачи»: title and status, a meta row (column, agent, targets, worktrees), the work, the journal. */
export function TaskPage({ task, ctx }: { task: Task | undefined; ctx: BoardCtx }) {
  if (!task) {
    return (
      <div className="detail-page" tabIndex={-1}>
        <DetailBar back="Задачи" />
        <div className="empty">
          <h2>Задачи больше нет</h2>
          <p>Её удалили с доски.</p>
          <button type="button" className="btn" onClick={closeDetail}>К задачам</button>
        </div>
      </div>
    )
  }
  return <TaskBody task={task} ctx={ctx} />
}

function TaskBody({ task, ctx }: { task: Task; ctx: BoardCtx }) {
  const titleId = useId()
  const now = useNow()
  const trackerOn = useStore((s) => s.integrations.tasks)
  const [panel, setPanel] = useState<'assign' | 'send' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const key = taskKey(task, ctx.byId)
  const parent = task.parentId ? ctx.byId.get(task.parentId) : undefined
  const session = task.assigneeSessionId ? ctx.sessions.get(task.assigneeSessionId) : undefined
  const blocked = pendingDeps(task, ctx.byId)
  const reworkOn = useFeature('rework')
  const reworkable = reworkOn && !!session && (session.status !== 'running' || task.status === 'review')
  const [pop, setPop] = useState<'start' | 'rework' | 'handoff' | null>(null)
  const startRef = useRef<HTMLButtonElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const patch = (fields: Partial<Task>) => patchTask(task.id, fields)
  const hasKids = (ctx.kids.get(task.id)?.length ?? 0) > 0

  const imported = isImported(task)
  // Imported tasks are only hidden by DELETE (re-import keeps them hidden); local ones are deleted.
  const remove = async () => {
    const ok = await tryApi<unknown>('DELETE', `/tasks/${encodeURIComponent(task.id)}`)
    if (ok === undefined) return
    setState((s) => ({ tasks: imported ? upsert(s.tasks, { ...task, hidden: true }) : without(s.tasks, task.id) }))
    closeDetail()
  }

  return (
    <div className="detail-page" role="region" aria-labelledby={titleId} tabIndex={-1}>
      <DetailBar back="Задачи" crumbs={<>
        {parent && <><button type="button" className="dp-crumb" onClick={() => ctx.onOpen(parent.id)} data-tip={`Родительская задача: ${parent.title}`}>{taskKey(parent, ctx.byId)}</button><span aria-hidden>/</span></>}
        <span className="mono" data-tip={task.id}>{key}</span>
      </>}>
        {task.externalUrl && (
          <a className="icon-btn" href={task.externalUrl} target="_blank" rel="noreferrer noopener" aria-label="Открыть в трекере" data-tip="Открыть в трекере">
            <ExternalLink />
          </a>
        )}
        <MenuButton label="Ещё действия" icon={<Ellipsis />} align="right" items={[
          { label: 'Назначить агенту…', icon: <UserPlus />, onSelect: () => setPanel('assign') },
          { label: 'Отправить в сессию…', icon: <Send />, onSelect: () => setPanel('send') },
          ...(!task.hidden ? [{ label: imported ? 'Скрыть с доски' : 'Удалить задачу', icon: imported ? <EyeOff /> : <Trash2 />, danger: !imported, divider: true, onSelect: () => setConfirmDelete(true) }] : []),
        ]} />
      </DetailBar>

      <div className="dp-scroll">
        <header className="dp-head">
          <div className="dp-title">
            <TitleField id={titleId} task={task} />
            <span className="dp-key mono">{key}</span>
          </div>
          <div className="dp-primary">
            {/* One primary action: take into work → open the running session → send back for rework once it finished. */}
            {!session ? (
              <button ref={primaryRef} type="button" className="btn btn-primary" disabled={blocked.length > 0} onClick={() => setPop('handoff')}>
                <Play />
                Передать агенту
              </button>
            ) : reworkable ? (
              <>
                <button type="button" className="btn" onClick={() => openSession(session.id)}>
                  <StatusIcon session={session} />
                  Открыть сессию
                </button>
                <button ref={primaryRef} type="button" className="btn btn-primary" onClick={() => setPop('rework')}>
                  <Wrench />
                  Доработать
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => openSession(session.id)}>
                <StatusIcon session={session} />
                Открыть сессию
              </button>
            )}
            {!session && <HandoffPopover task={task} anchor={primaryRef} open={pop === 'handoff'} onClose={() => setPop(null)} />}
            {reworkable && <ReworkPopover task={task} anchor={primaryRef} open={pop === 'rework'} onClose={() => setPop(null)} />}
          </div>
          <div className="dp-sub">
            <span className="dp-status" data-s={task.status}><span className="col-mark" data-s={task.status} aria-hidden />{statusLabel(task.status)}</span>
            {task.externalStatus && <span className="chip" data-tip="Статус в трекере">трекер: {task.externalStatus}</span>}
            {task.hidden && <span className="chip">скрыта с доски</span>}
            <span className="muted" data-tip={`обновлено ${fullTime(task.updatedAt)}`}>
              {task.takenAt ? `в работе с ${relTime(task.takenAt, now)}` : `обновлено ${relTime(task.updatedAt, now)}`}
            </span>
          </div>
        </header>

        <div className="dp-meta">
          <Meta label="Статус">
            <Select size="sm" label="Колонка на доске" value={task.status} onChange={(v) => void patch({ status: v as TaskStatus })} options={COLUMNS.map((c) => ({ value: c.id, label: c.label }))} />
          </Meta>
          <Meta label="Агент">
            {session ? <TaskAgent task={task} session={session} ctx={ctx} /> : <span className="muted">Не назначен</span>}
            {session && <span className="dp-agent-meta muted">{session.title} · {ctx.agents.get(session.agent)?.label ?? session.agent}</span>}
          </Meta>
          <Meta label="Целевые ветки">
            <TargetsLine targets={task.targets} workspaceId={task.workspaceId} onChange={(targets) => void patch({ targets })} />
          </Meta>
          <Meta label="Рабочие деревья"><TaskWorktrees task={task} /></Meta>
        </div>

        <div className="dp-body">
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
          {!session && <UnboundChat task={task} taskKey={key} />}
          {blocked.length > 0 && <p className="drawer-blocked">Ждёт задач: {blocked.join(', ')}</p>}
          {confirmDelete && (
            <div className="drawer-note drawer-confirm">
              <span>{imported ? `Скрыть ${key} с доски? В трекере задача останется.` : `Удалить ${task.id} без возможности восстановления?`}</span>
              <button type="button" className={imported ? 'btn btn-sm' : 'btn btn-sm btn-danger'} onClick={() => void remove()}>{imported ? 'Скрыть' : 'Удалить'}</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmDelete(false)}>Отмена</button>
            </div>
          )}
          {panel === 'assign' && <AssignForm task={task} onDone={() => setPanel(null)} />}
          {panel === 'send' && <SendForm task={task} onDone={() => setPanel(null)} />}

          <section className="dp-card">
            <h3 className="dp-card-head">Описание{imported && <span className="muted">из трекера</span>}</h3>
            {imported ? (task.description.trim() ? <div className="md-preview drawer-desc"><Markdown text={task.description} /></div> : <ExternalCard task={task} full />) : <DescriptionField task={task} />}
            {(task.externalLinks?.length ?? 0) > 0 && (
              <ul className="drawer-links" aria-label="Ссылки из полей задачи">
                {task.externalLinks!.map((l) => <li key={l.url}><span className="muted">{l.name}: </span><a href={l.url} target="_blank" rel="noreferrer noopener">{l.url}</a></li>)}
              </ul>
            )}
          </section>
          <TaskPrs task={task} />
          {task.targets.length > 1 && <Ports task={task} />}
          {hasKids && <Subtasks task={task} ctx={ctx} />}

          <Disclosure className="drawer-more dp-fold" summary={<h3>Настроить запуск</h3>}>
            <WorkSummary task={task} />
            {!session && (
              <div className="row">
                <button ref={startRef} type="button" className="btn btn-sm" disabled={blocked.length > 0} onClick={() => setPop('start')}><Play />Взять в работу в репозитории…</button>
                <StartPopover task={task} anchor={startRef} open={pop === 'start'} onClose={() => setPop(null)} />
              </div>
            )}
          </Disclosure>
          {trackerOn && task.externalId && (
            <Disclosure className="drawer-more dp-fold" summary={<h3>Статус в трекере</h3>}>
              <TrackerStatus task={task} />
              {imported && task.description.trim() && <ExternalCard task={task} full={false} />}
            </Disclosure>
          )}
          <Disclosure className="drawer-more dp-fold" summary={<h3>Ещё: приоритет, зависимости, метки</h3>}>
            <div className="props">
              <Prop label="Приоритет"><Select size="sm" label="Приоритет" value={task.priority ?? ''} onChange={(v) => void patch({ priority: (v || null) as Task['priority'] })}
                options={[{ value: '', label: 'Без приоритета' }, ...(['high', 'medium', 'low'] as const).map((p) => ({ value: p, label: PRIORITY[p] }))]} /></Prop>
              <Prop label="Зависимости"><DepsField task={task} ctx={ctx} onChange={(deps) => void patch({ deps })} /></Prop>
              <Prop label="Метки"><ChipsInput values={task.labels} label="метку" onChange={(labels) => void patch({ labels })} /></Prop>
            </div>
            {!hasKids && <Subtasks task={task} ctx={ctx} />}
          </Disclosure>
          <Activity task={task} sessions={ctx.sessions} />
        </div>
      </div>
    </div>
  )
}

/** The agent as on the board card: the harness's check / review explained, else the chat's live state; a click opens the chat. */
function TaskAgent({ task, session, ctx }: { task: Task; session: Session; ctx: BoardCtx }) {
  const now = useNow()
  if (chipStates(task)) return <AgentBadge task={task} session={session} ctx={ctx} />
  const c = agentChip(task, chipChat(session), null, now, dur)
  return (
    <button type="button" className="agent-badge" data-s={sessionVisualState(session)} data-tip={c.tip} aria-label={`${c.text}. ${c.tip}`} onClick={() => openSession(session.id)}>
      <StatusIcon session={session} />{c.text}
    </button>
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
        <span className="mono" data-tip={task.branch ? undefined : 'создастся при запуске'}>{branch}</span>
        {agent && <><span className="muted">·</span><span>{agent}</span></>}
        <IconButton size="sm" label={open ? 'Скрыть поля' : 'Изменить репозиторий и ветку'} icon={<Pencil />} onClick={() => setOpen(!open)} aria-expanded={open} />
      </div>
      <div className="collapse" data-open={open}>
        <div>
          {open && (
            <div className="props work-fields">
              <Prop label="Репозиторий">
                <Select label="Репозиторий" value={task.workspaceId ?? ''} onChange={(v) => void patch({ workspaceId: v || null })}
                  options={[{ value: '', label: 'Не выбран (агент решит)' }, ...workspaces.filter((w) => w.kind !== 'root' && w.kind !== 'folder').map((w) => ({ value: w.id, label: w.name, hint: task.suggestedWorkspace?.id === w.id ? (task.suggestedWorkspace.reason ?? 'возможно') : undefined }))]} />
              </Prop>
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
  if (!list.length) return <span className="muted">Пока нет</span>
  return (
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
  const [why, setWhy] = useState<string | null>(null) // the tracker did not give the list (not: an older server)

  useEffect(() => {
    let live = true
    api<Transitions>('GET', `/tasks/${encodeURIComponent(task.id)}/transitions`).then(
      (r) => { if (live) { setList(r?.transitions ? r : null); setWhy(null) } },
      (e) => { if (live) { setList(null); setWhy(e instanceof ApiError && e.status !== 404 && e.status !== 501 ? e.message : null) } }, // free-text status below
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
            {why && <p className="field-hint">Список переходов из трекера не загрузился ({why}). Напишите статус, как он называется в трекере: переход в него найдётся по названию.</p>}
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
    <section className="dp-card">
      <h3 className="dp-card-head">Портирование</h3>
      {!task.branch && <p className="field-hint">Перенос станет доступен, когда у задачи появится рабочая ветка.</p>}
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
    <section className="dp-card">
      <h3 className="dp-card-head">
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

/** «Журнал» as a timeline of events: who, what, when; an entry with a link (a PR created) opens it. */
function Activity({ task, sessions }: { task: Task; sessions: Map<string, Session> }) {
  const now = useNow()
  const log = task.log.filter((l) => typeof l.text === 'string' && l.text.trim()) // technical entries without text stay hidden
  if (!log.length) return null
  return (
    <section className="dp-events" aria-label="Журнал задачи">
      <h3 className="dp-card-head"><History aria-hidden />Журнал <span className="count">{log.length}</span></h3>
      <ol className="timeline">
        {log.map((l, i) => {
          const chat = sessions.get(l.by)
          const Icon = l.by === 'user' ? User : l.by === 'harness' ? Settings2 : Bot
          const url = typeof l.data?.url === 'string' ? l.data.url : null
          return (
            <li key={i}>
              <span className="timeline-dot" aria-hidden><Icon /></span>
              <span className="timeline-text">
                {chat ? <button type="button" className="timeline-by" onClick={() => openSession(chat.id)} data-tip="Открыть чат">{chat.title}</button>
                  : <strong className="timeline-by">{l.by === 'user' ? 'вы' : l.by}</strong>}
                {' '}<span className="activity-text">{l.text}</span>
                {url && <> <a href={url} target="_blank" rel="noreferrer noopener">открыть</a></>}
                {' '}<span className="muted" data-tip={fullTime(l.at)}>{relTime(l.at, now)}</span>
              </span>
            </li>
          )
        })}
      </ol>
    </section>
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
    <section className="dp-card">
      <h3 className="dp-card-head">Пулл-реквесты</h3>
      {!enabled ? (
        <div className="pr-off"><span className="muted">PR-интеграция не настроена.</span><button type="button" className="btn btn-sm" onClick={openPrSettings}>Настроить</button></div>
      ) : (
        <div className="ports">
          <PrRow target={task.targets[0]} cwd={mainCwd} branch={task.branch} known={task.pr ?? null} />
          {task.targets.slice(1).map((t) => {
            const p = task.ports.find((x) => x.target === t)
            return <PrRow key={t} target={t} cwd={p?.cwd ?? null} branch={p?.branch ?? null} known={null} />
          })}
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
        <span className="muted">ветки ещё нет</span>
      ) : pr === undefined ? (
        <span className="muted">проверяем…</span>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => openDialog({ kind: 'pr', cwd, base: target })}>Создать PR в {target}</button>
      )}
    </div>
  )
}

/** A chat that names this task (its key or link) but is not bound to it: «Привязать» gives the task its agent. */
function UnboundChat({ task, taskKey: key }: { task: Task; taskKey: string }) {
  const bindOn = useFeature('bind-task')
  const chat = useStore((s) => s.sessions.find((x) => x.kind === 'chat' && !x.virtual && !x.archived && !x.taskId
    && (x.title.includes(key) || (!!task.externalUrl && x.title.includes(task.externalUrl)))))
  const [busy, setBusy] = useState(false)
  if (!bindOn || !chat) return null
  const bind = async () => {
    setBusy(true)
    const r = await tryApi<{ task: Task; session: Session }>('POST', `/sessions/${encodeURIComponent(chat.id)}/task`, { ref: key })
    setBusy(false)
    if (r) setState((s) => ({ tasks: upsert(s.tasks, r.task), sessions: upsertSession(s.sessions, r.session) }))
  }
  return (
    <div className="drawer-note">
      <span>Над задачей, похоже, работает чат «{chat.title}», но он к ней не привязан.</span>
      <button type="button" className="btn btn-sm" onClick={() => openSession(chat.id)}>Открыть</button>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void bind()}>{busy ? 'Привязываю…' : 'Привязать'}</button>
    </div>
  )
}
